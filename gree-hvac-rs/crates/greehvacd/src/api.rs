//! HTTP surface for the PWA.
//!
//!   GET  /api/health      -> {"status":"ok","ac":{"connected":bool}}
//!   GET  /api/state       -> the friendly state DTO
//!   GET  /api/events      -> SSE: the DTO on connect, then on every change
//!   POST /api/power       -> {"on":bool}
//!   POST /api/temp        -> {"temp":16..30}
//!   POST /api/mode        -> {"mode":"cool"}
//!   POST /api/fan         -> {"speed":"high"}
//!   POST /api/swing       -> {"vert":"full","hor":"fixedMid"}  (either or both)
//!   POST /api/option      -> {"key":"turbo","value":true}
//!   POST /api/properties  -> {"mode":"heat","temperature":22}  (raw escape hatch)
//!
//! Every write answers with the fresh DTO, so a client can apply the response
//! directly. Writes are optimistic by one round trip: UDP has no ack, so the
//! response echoes what we sent and the device's confirmation lands moments
//! later on `/api/events` (and in the next `/api/state`).
//!
//! CORS origin is configurable (default: any). If a bearer token is provided,
//! every /api request must carry `Authorization: Bearer <token>`.

use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::{from_fn, from_fn_with_state, Next};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Json, Router};
use futures_util::stream::Stream;
use serde_json::{json, Value};
use tokio::sync::oneshot;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

use greehvac::property::{self, Property};

use crate::actor::{Command, DeviceState};
use crate::state::{self, AcState, TEMP_MIN, TEMP_MAX};
use crate::AppState;

/// How long a write waits for the device thread to put the datagram on the
/// wire. Generous: the thread checks its queue every `read_timeout` (20 ms),
/// so exceeding this means it is wedged, not merely busy.
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);

/// Boolean options, mapped to the protocol property each one drives.
const TOGGLE_KEYS: [(&str, Property); 7] = [
    ("lights", Property::Lights),
    ("turbo", Property::Turbo),
    ("sleep", Property::Sleep),
    ("xfan", Property::Blow),
    ("health", Property::Health),
    ("powerSave", Property::PowerSave),
    ("safetyHeating", Property::SafetyHeating),
];

/// Small-enum options. Values are validated against the protocol tables.
const ENUM_KEYS: [(&str, Property); 3] = [
    ("quiet", Property::Quiet),
    ("air", Property::Air),
    ("unit", Property::TemperatureUnit),
];

pub struct ApiConfig {
    pub cors_origin: Option<String>,
    pub token: Option<String>,
    pub public_dir: Option<PathBuf>,
}

pub fn router(state: AppState, config: ApiConfig) -> Router {
    let mut api = Router::new()
        .route("/api/health", get(health))
        .route("/api/state", get(get_state))
        .route("/api/events", get(events))
        .route("/api/power", post(set_power))
        .route("/api/temp", post(set_temp))
        .route("/api/mode", post(set_mode))
        .route("/api/fan", post(set_fan))
        .route("/api/swing", post(set_swing))
        .route("/api/option", post(set_option))
        .route("/api/properties", post(set_properties))
        // Unknown /api paths must answer with the same {"error": ...} envelope
        // instead of falling through to the SPA fallback (or an empty 404).
        .route("/api/*rest", any(api_not_found))
        .layer(from_fn(no_store))
        .with_state(state);

    if let Some(secret) = config.token {
        let secret: Arc<str> = Arc::from(secret);
        api = api.layer(from_fn_with_state(secret, auth));
    }

    // Serve the built PWA underneath the API, with an index.html fallback so
    // client-side routes and a cold "Add to Home Screen" launch both resolve.
    let mut app = match config.public_dir {
        Some(dir) => api.fallback_service(static_files(dir)),
        None => api,
    };

    // CORS is the outermost layer so it answers preflight OPTIONS before auth.
    app = app.layer(cors_layer(config.cors_origin));
    app
}

/// The built PWA, served with the two things that decide how a phone on the
/// LAN experiences a cold launch.
///
/// **Precompressed variants.** `npm run build` writes `.br`/`.gz` siblings, and
/// these serve them as-is: the bridge may be a Pi Zero W, where compressing on
/// the fly would burn CPU on every request, and the app bundle is ~3x smaller
/// this way. Falls back to the plain file when a client offers no encoding.
///
/// **Cache-Control.** Vite fingerprints everything under `/assets/`, so those
/// URLs are immutable by construction and a phone should never re-request them.
/// Everything else — `index.html`, `sw.js`, the manifest, icons — must
/// revalidate, or a rebuilt app would never reach an installed home-screen
/// launcher.
fn static_files(dir: PathBuf) -> Router {
    let index = dir.join("index.html");
    let files = ServeDir::new(&dir)
        .precompressed_br()
        .precompressed_gzip()
        .fallback(
            ServeFile::new(index)
                .precompressed_br()
                .precompressed_gzip(),
        );

    Router::new()
        .fallback_service(files)
        .layer(from_fn(cache_static))
}

async fn cache_static(request: Request, next: Next) -> Response {
    let immutable = request.uri().path().starts_with("/assets/");
    let mut response = next.run(request).await;

    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(match immutable {
            true => "public, max-age=31536000, immutable",
            false => "no-cache",
        }),
    );
    response
}

/// `*` (or unset) allows any origin — the trusted-LAN default. Otherwise a
/// comma-separated allowlist, matching what the Node bridge accepted.
fn cors_layer(origin: Option<String>) -> CorsLayer {
    let layer = CorsLayer::new().allow_methods(Any).allow_headers(Any);

    let Some(spec) = origin.filter(|s| !s.trim().is_empty() && "*" != s.trim()) else {
        return layer.allow_origin(Any);
    };

    let origins: Vec<HeaderValue> = spec
        .split(',')
        .filter_map(|o| o.trim().parse().ok())
        .collect();

    if origins.is_empty() {
        log::warn!("CORS_ORIGIN has no parseable origin; allowing any");
        return layer.allow_origin(Any);
    }
    layer.allow_origin(AllowOrigin::list(origins))
}

// ---------------------------------------------------------------- reads

async fn health(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "status": "ok", "ac": { "connected": device(&state).online } }))
}

async fn get_state(State(state): State<AppState>) -> Json<AcState> {
    let device = device(&state);
    Json(state::dto(&device.props, device.online, device.updated_at))
}

async fn events(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
    // Emit the current state immediately so a freshly-connected client has
    // something to render without waiting for the next change.
    let device = device(&state);
    let dto = state::dto(&device.props, device.online, device.updated_at);
    let initial = tokio_stream::once(Ok::<_, Infallible>(
        SseEvent::default().data(serde_json::to_string(&dto).unwrap_or_default()),
    ));

    let live = BroadcastStream::new(state.updates.subscribe()).filter_map(|result| match result {
        Ok(payload) => Some(Ok(SseEvent::default().data(payload))),
        Err(_) => None, // lagged receiver: drop and continue (state is self-healing)
    });

    Sse::new(initial.chain(live)).keep_alive(KeepAlive::default())
}

// --------------------------------------------------------------- writes

async fn set_power(
    State(state): State<AppState>,
    body: String,
) -> Result<Json<AcState>, ApiError> {
    let body = parse_body(&body)?;
    let on = body
        .get("on")
        .and_then(Value::as_bool)
        .ok_or_else(|| ApiError::bad_request("body must be { on: boolean }"))?;

    write(&state, vec![(Property::Power, i64::from(on))]).await
}

async fn set_temp(State(state): State<AppState>, body: String) -> Result<Json<AcState>, ApiError> {
    let body = parse_body(&body)?;
    let temp = body
        .get("temp")
        .and_then(Value::as_f64)
        .map(f64::round)
        .filter(|t| (TEMP_MIN as f64..=TEMP_MAX as f64).contains(t))
        .ok_or_else(|| {
            ApiError::bad_request(format!(
                "body must be {{ temp: number }} within {TEMP_MIN}-{TEMP_MAX}"
            ))
        })?;

    write(&state, vec![(Property::Temperature, temp as i64)]).await
}

async fn set_mode(State(state): State<AppState>, body: String) -> Result<Json<AcState>, ApiError> {
    let body = parse_body(&body)?;
    let mode = enum_field(&body, "mode", Property::Mode)?;
    write(&state, vec![(Property::Mode, mode)]).await
}

async fn set_fan(State(state): State<AppState>, body: String) -> Result<Json<AcState>, ApiError> {
    let body = parse_body(&body)?;
    let speed = enum_field(&body, "speed", Property::FanSpeed)?;
    write(&state, vec![(Property::FanSpeed, speed)]).await
}

async fn set_swing(State(state): State<AppState>, body: String) -> Result<Json<AcState>, ApiError> {
    let body = parse_body(&body)?;

    let mut props = Vec::new();
    if present(&body, "vert") {
        props.push((Property::SwingVert, enum_field(&body, "vert", Property::SwingVert)?));
    }
    if present(&body, "hor") {
        props.push((Property::SwingHor, enum_field(&body, "hor", Property::SwingHor)?));
    }
    if props.is_empty() {
        return Err(ApiError::bad_request("body must include vert and/or hor"));
    }

    write(&state, props).await
}

async fn set_option(State(state): State<AppState>, body: String) -> Result<Json<AcState>, ApiError> {
    let body = parse_body(&body)?;
    let key = body.get("key").and_then(Value::as_str).unwrap_or_default();
    let value = body.get("value").unwrap_or(&Value::Null);

    if let Some((_, property)) = TOGGLE_KEYS.iter().find(|(name, _)| *name == key) {
        let on = value
            .as_bool()
            .ok_or_else(|| ApiError::bad_request(format!("{key} value must be boolean")))?;
        return write(&state, vec![(*property, i64::from(on))]).await;
    }

    if let Some((_, property)) = ENUM_KEYS.iter().find(|(name, _)| *name == key) {
        let raw = value
            .as_str()
            .and_then(|v| property::value_names(*property).contains(&v).then_some(v))
            .ok_or_else(|| {
                ApiError::bad_request(format!(
                    "{key} value must be one of: {}",
                    property::value_names(*property).join(", ")
                ))
            })?;
        let code = property::value_to_vendor(*property, &Value::from(raw))
            .map_err(|e| ApiError::bad_request(e.to_string()))?;
        return write(&state, vec![(*property, code)]).await;
    }

    let keys: Vec<&str> = TOGGLE_KEYS
        .iter()
        .chain(ENUM_KEYS.iter())
        .map(|(name, _)| *name)
        .collect();
    Err(ApiError::bad_request(format!(
        "key must be one of: {}",
        keys.join(", ")
    )))
}

/// Raw escape hatch: write any protocol property by its library name, e.g.
/// `{"mode":"heat","temperature":22}`. Useful for probing and for anything the
/// task-shaped endpoints above don't cover.
async fn set_properties(
    State(state): State<AppState>,
    body: String,
) -> Result<Json<AcState>, ApiError> {
    let body = parse_body(&body)?;
    let object = body
        .as_object()
        .ok_or_else(|| ApiError::bad_request("expected a JSON object"))?;
    let props = property::to_vendor(object).map_err(|e| ApiError::bad_request(e.to_string()))?;
    if props.is_empty() {
        return Err(ApiError::bad_request("body must include a property"));
    }

    write(&state, props).await
}

/// Hand a write to the device thread, wait for it to reach the wire, and answer
/// with the state the client should now show.
async fn write(
    state: &AppState,
    props: Vec<(Property, i64)>,
) -> Result<Json<AcState>, ApiError> {
    let device = device(state);
    if !device.online {
        return Err(ApiError::offline());
    }

    let (reply_tx, reply_rx) = oneshot::channel();
    state
        .cmd_tx
        .send(Command::Set(props.clone(), reply_tx))
        .map_err(|_| ApiError::offline())?;

    match tokio::time::timeout(WRITE_TIMEOUT, reply_rx).await {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(e))) => return Err(ApiError(StatusCode::INTERNAL_SERVER_ERROR, e)),
        // Reply channel dropped: the device thread lost the session (and the
        // command with it) before it could send.
        Ok(Err(_)) => return Err(ApiError::offline()),
        Err(_) => {
            return Err(ApiError(
                StatusCode::GATEWAY_TIMEOUT,
                "timed out sending to the AC".to_string(),
            ))
        }
    }

    // Optimistic echo — see the module docs. The snapshot itself stays device
    // truth; only this response carries the just-written values.
    let mut echoed = device.props;
    echoed.extend(props);
    Ok(Json(state::dto(&echoed, true, device.updated_at)))
}

// ---------------------------------------------------------------- helpers

fn device(state: &AppState) -> DeviceState {
    state
        .snapshot
        .read()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

fn parse_body(body: &str) -> Result<Value, ApiError> {
    if body.trim().is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    serde_json::from_str(body).map_err(|_| ApiError::bad_request("body must be valid JSON"))
}

/// JSON has no `undefined`, but a client may still send an explicit `null`.
/// Treat both as "field omitted".
fn present(body: &Value, field: &str) -> bool {
    !matches!(body.get(field), None | Some(Value::Null))
}

/// Read an enum-valued field, rejecting anything outside the protocol table
/// with the list of what would have been accepted.
fn enum_field(body: &Value, field: &str, property: Property) -> Result<i64, ApiError> {
    let allowed = property::value_names(property);
    body.get(field)
        .and_then(Value::as_str)
        .filter(|v| allowed.contains(v))
        .and_then(|v| property::value_to_vendor(property, &Value::from(v)).ok())
        .ok_or_else(|| {
            ApiError::bad_request(format!("{field} must be one of: {}", allowed.join(", ")))
        })
}

pub struct ApiError(StatusCode, String);

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self(StatusCode::BAD_REQUEST, message.into())
    }

    fn offline() -> Self {
        Self(
            StatusCode::SERVICE_UNAVAILABLE,
            "AC not connected".to_string(),
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

async fn api_not_found() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "unknown API route".to_string())
}

/// Live device state must never be cached — a browser would otherwise reuse a
/// stale reading (e.g. after a change from the physical remote) until a reload.
async fn no_store(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// Token gate. Applied only when a token is configured. Accepts either an
/// `Authorization: Bearer <token>` header or a `?token=<token>` query parameter
/// — the latter because browser `EventSource` cannot send custom headers.
/// Preflight OPTIONS is allowed through so CORS still works.
async fn auth(
    State(secret): State<Arc<str>>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    if Method::OPTIONS == *request.method() {
        return Ok(next.run(request).await);
    }

    let secret = secret.as_ref();

    let header_ok = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|value| value == secret)
        .unwrap_or(false);

    // NOTE: query-param tokens can end up in access logs. Prefer the header
    // everywhere except the EventSource connection.
    let query_ok = request
        .uri()
        .query()
        .into_iter()
        .flat_map(|q| q.split('&'))
        .filter_map(|pair| pair.strip_prefix("token="))
        .any(|value| value == secret);

    if header_ok || query_ok {
        return Ok(next.run(request).await);
    }
    // Same {"error": ...} envelope as every other API failure, so a client's
    // uniform `body.error` handling works on 401 too.
    Err(ApiError(
        StatusCode::UNAUTHORIZED,
        "invalid or missing token".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Props;
    use axum::body::Body;
    use std::sync::mpsc;
    use std::sync::RwLock;
    use tokio::sync::broadcast;
    use tower::ServiceExt; // for `oneshot`

    /// Every property batch the stand-in device thread has acked, in order.
    type SentCommands = Arc<RwLock<Vec<Vec<(Property, i64)>>>>;

    /// A router wired to a seeded snapshot. When `online`, a stand-in device
    /// thread acks every command and records it, so write paths can be driven
    /// without hardware.
    fn harness(online: bool) -> (Router, SentCommands) {
        let props = Props::from([
            (Property::Power, 1),
            (Property::Mode, 1),
            (Property::Temperature, 24),
            (Property::CurrentTemperature, 62),
            (Property::FanSpeed, 0),
        ]);
        let snapshot = Arc::new(RwLock::new(DeviceState {
            online,
            props,
            updated_at: None,
        }));
        let (cmd_tx, cmd_rx) = mpsc::channel::<Command>();
        let (updates, _rx) = broadcast::channel::<String>(8);

        let sent = Arc::new(RwLock::new(Vec::new()));
        {
            let sent = sent.clone();
            std::thread::spawn(move || {
                while let Ok(Command::Set(props, reply)) = cmd_rx.recv() {
                    sent.write().unwrap().push(props);
                    let _ = reply.send(Ok(()));
                }
            });
        }

        let state = AppState {
            snapshot,
            cmd_tx,
            updates,
        };
        let router = router(
            state,
            ApiConfig {
                cors_origin: None,
                token: None,
                public_dir: None,
            },
        );
        (router, sent)
    }

    async fn call(router: &Router, method: &str, path: &str, body: &str) -> (StatusCode, Value) {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    #[tokio::test]
    async fn state_uses_the_app_dto() {
        let (router, _) = harness(true);
        let (status, body) = call(&router, "GET", "/api/state", "").await;

        assert_eq!(StatusCode::OK, status);
        assert_eq!(json!(true), body["online"]);
        assert_eq!(json!(true), body["power"]);
        assert_eq!(json!("cool"), body["mode"]);
        assert_eq!(json!(24), body["targetTemp"]);
        assert_eq!(json!(22), body["currentTemp"]);
        // Never reported by this fixture -> null, not a missing key.
        assert_eq!(Value::Null, body["outdoorTemp"]);
        assert_eq!(json!(false), body["turbo"]);
    }

    #[tokio::test]
    async fn health_reports_the_connection() {
        let (online, _) = harness(true);
        let (_, body) = call(&online, "GET", "/api/health", "").await;
        assert_eq!(json!({"status": "ok", "ac": {"connected": true}}), body);

        let (offline, _) = harness(false);
        let (_, body) = call(&offline, "GET", "/api/health", "").await;
        assert_eq!(json!(false), body["ac"]["connected"]);
    }

    #[tokio::test]
    async fn live_state_is_never_cached() {
        let (router, _) = harness(true);
        let request = Request::builder()
            .uri("/api/state")
            .body(Body::empty())
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        assert_eq!("no-store", response.headers()[header::CACHE_CONTROL]);
    }

    #[tokio::test]
    async fn writes_reach_the_device_and_echo_the_new_state() {
        let (router, sent) = harness(true);

        let (status, body) = call(&router, "POST", "/api/power", r#"{"on":false}"#).await;
        assert_eq!(StatusCode::OK, status);
        assert_eq!(json!(false), body["power"]);

        let (_, body) = call(&router, "POST", "/api/temp", r#"{"temp":21}"#).await;
        assert_eq!(json!(21), body["targetTemp"]);

        // `xfan` is the app's name for the protocol's `Blo`.
        let (_, body) = call(
            &router,
            "POST",
            "/api/option",
            r#"{"key":"xfan","value":true}"#,
        )
        .await;
        assert_eq!(json!(true), body["xfan"]);

        let (_, body) = call(&router, "POST", "/api/swing", r#"{"vert":"full"}"#).await;
        assert_eq!(json!("full"), body["swingVert"]);

        assert_eq!(
            vec![
                vec![(Property::Power, 0)],
                vec![(Property::Temperature, 21)],
                vec![(Property::Blow, 1)],
                vec![(Property::SwingVert, 1)],
            ],
            *sent.read().unwrap()
        );
    }

    #[tokio::test]
    async fn bad_values_are_rejected_with_the_accepted_set() {
        let (router, sent) = harness(true);

        let cases = [
            ("/api/power", r#"{"on":"yes"}"#, "body must be { on: boolean }"),
            (
                "/api/temp",
                r#"{"temp":40}"#,
                "body must be { temp: number } within 16-30",
            ),
            (
                "/api/mode",
                r#"{"mode":"turbo"}"#,
                "mode must be one of: auto, cool, dry, fan_only, heat",
            ),
            (
                "/api/swing",
                r#"{}"#,
                "body must include vert and/or hor",
            ),
            (
                "/api/option",
                r#"{"key":"turbo","value":"on"}"#,
                "turbo value must be boolean",
            ),
            (
                "/api/option",
                r#"{"key":"buzzer","value":true}"#,
                "key must be one of: lights, turbo, sleep, xfan, health, powerSave, \
                 safetyHeating, quiet, air, unit",
            ),
        ];

        for (path, body, expected) in cases {
            let (status, response) = call(&router, "POST", path, body).await;
            assert_eq!(StatusCode::BAD_REQUEST, status, "{path} {body}");
            assert_eq!(json!(expected), response["error"], "{path} {body}");
        }

        // A rejected request must never have reached the device.
        assert!(sent.read().unwrap().is_empty());
    }

    #[tokio::test]
    async fn read_only_properties_cannot_be_written() {
        let (router, _) = harness(true);
        let (status, body) = call(
            &router,
            "POST",
            "/api/properties",
            r#"{"currentTemperature":20}"#,
        )
        .await;
        assert_eq!(StatusCode::BAD_REQUEST, status);
        assert_eq!(json!("read-only property: currentTemperature"), body["error"]);
    }

    #[tokio::test]
    async fn writes_fail_fast_while_the_ac_is_unreachable() {
        let (router, sent) = harness(false);
        let (status, body) = call(&router, "POST", "/api/power", r#"{"on":true}"#).await;

        assert_eq!(StatusCode::SERVICE_UNAVAILABLE, status);
        assert_eq!(json!("AC not connected"), body["error"]);
        assert!(sent.read().unwrap().is_empty());
    }

    #[tokio::test]
    async fn offline_state_keeps_the_last_known_settings() {
        let (router, _) = harness(false);
        let (_, body) = call(&router, "GET", "/api/state", "").await;

        assert_eq!(json!(false), body["online"]);
        // Greyed out in the UI, but not blanked.
        assert_eq!(json!("cool"), body["mode"]);
        assert_eq!(json!(24), body["targetTemp"]);
    }
}
