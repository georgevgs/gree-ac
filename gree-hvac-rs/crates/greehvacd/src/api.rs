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
//! Every POST must carry `Content-Type: application/json`; anything else is
//! refused with 415 before the handler runs, which also keeps cross-site
//! writes out of the CORS "simple request" category. CORS itself is opt-in:
//! with no allowlist configured the daemon adds no cross-origin allowance at
//! all (the PWA is served same-origin). If a bearer token is provided, every
//! /api request must carry `Authorization: Bearer <token>`.

use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::rejection::StringRejection;
use axum::extract::{FromRequest, Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::{from_fn, from_fn_with_state, Next};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{async_trait, Json, Router};
use futures_util::stream::Stream;
use serde_json::{json, Value};
use tokio::sync::oneshot;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use tower_http::cors::{AllowOrigin, CorsLayer};
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
        // `/*rest` needs at least one segment, so bare `/api` and `/api/` would
        // otherwise sail past this router — and past the token gate — into the
        // static fallback and come back as the app shell with a 200.
        .route("/api", any(api_not_found))
        .route("/api/", any(api_not_found))
        .route("/api/*rest", any(api_not_found))
        // A GET on a POST-only route is answered by axum itself, which emits a
        // bare 405 with an empty body. Route it through ApiError so the
        // documented envelope holds on every /api response, not most of them.
        .method_not_allowed_fallback(method_not_allowed)
        .layer(from_fn(require_json))
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
    if let Some(cors) = cors_layer(config.cors_origin) {
        app = app.layer(cors);
    }
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
    let assets = ServeDir::new(dir.join("assets"))
        .precompressed_br()
        .precompressed_gzip();
    let files = ServeDir::new(&dir)
        .precompressed_br()
        .precompressed_gzip()
        .fallback(
            ServeFile::new(index)
                .precompressed_br()
                .precompressed_gzip(),
        );

    Router::new()
        // Hashed assets are served WITHOUT the SPA fallback, so a miss is a 404.
        // Sharing the fallback would answer a stale `/assets/index-OLD.js` with
        // index.html, which `cache_static` then stamps `immutable` at a .js URL:
        // the script fails on MIME type and the browser holds that wrong body
        // for a year. One deploy race, a year of white screens.
        .nest_service("/assets", assets)
        .fallback_service(files)
        .layer(from_fn(cache_static))
}

/// Cache policy, plus the security headers for everything the browser renders.
///
/// The bearer token lives in `localStorage`, so a script injected into this
/// origin could read it. There is no injection point today (the PWA has no HTML
/// sinks), and CSP is what keeps that true if one ever appears. `frame-ancestors`
/// is the load-bearing one right now: without it any page can iframe the bridge
/// and clickjack the power toggle for anyone whose browser can reach the tailnet.
async fn cache_static(request: Request, next: Next) -> Response {
    let hashed = request.uri().path().starts_with("/assets/");
    let mut response = next.run(request).await;

    // `immutable` promises the bytes at this URL never change. Only promise it
    // for a hashed asset that actually resolved — caching a 404 for a year is a
    // self-inflicted outage.
    let immutable = hashed && response.status().is_success();

    let headers = response.headers_mut();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(match immutable {
            true => "public, max-age=31536000, immutable",
            false => "no-cache",
        }),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    // `script-src` still needs 'unsafe-inline' for the pre-paint theme script in
    // index.html, which has to run before first paint to avoid a scheme flash.
    // Moving it to a file would cost a round trip on every cold load; hashing it
    // would couple this header to the built HTML. Everything else is locked down.
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; \
             script-src 'self' 'unsafe-inline'; \
             style-src 'self' 'unsafe-inline'; \
             img-src 'self' data:; \
             font-src 'self'; \
             connect-src 'self'; \
             manifest-src 'self'; \
             frame-ancestors 'none'; \
             base-uri 'none'; \
             form-action 'none'; \
             object-src 'none'",
        ),
    );
    response
}

/// Unset (or blank) means no CORS layer at all: the daemon serves the PWA
/// same-origin, so no cross-origin allowance is needed. Otherwise a
/// comma-separated allowlist — in practice just the Vite dev server.
///
/// `*` is refused. The whole reason a drive-by page cannot POST to this daemon
/// is that `require_json` forces a preflight and the absent CORS policy fails
/// it; `*` would answer that preflight and hand every page on the internet the
/// heat pump. The dev-server case it was meant to serve is covered exactly by
/// naming `http://localhost:5173`.
fn cors_layer(origin: Option<String>) -> Option<CorsLayer> {
    let spec = origin?;
    let spec = spec.trim();
    if spec.is_empty() {
        return None;
    }

    if "*" == spec {
        log::error!(
            "CORS_ORIGIN=* would let any website drive this AC; refusing it. \
             Name the origin instead, e.g. CORS_ORIGIN=http://localhost:5173"
        );
        return None;
    }

    // A bare `HeaderValue` parse accepts any visible ASCII, so `localhost:5173`
    // (no scheme) would sail through and then silently never match an Origin.
    // Say so at startup instead of shipping an app that cannot talk to itself.
    let mut origins: Vec<HeaderValue> = Vec::new();
    for entry in spec.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        match is_origin(entry).then(|| entry.parse().ok()).flatten() {
            Some(value) => origins.push(value),
            None => log::warn!(
                "CORS_ORIGIN entry {entry:?} is not a scheme://host[:port] origin; ignoring it"
            ),
        }
    }

    if origins.is_empty() {
        log::warn!("CORS_ORIGIN has no usable origin; cross-origin access stays off");
        return None;
    }
    Some(
        CorsLayer::new()
            .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
            // Only what the PWA actually sends. `Any` would also make
            // `Authorization` a permitted cross-origin header.
            .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
            .allow_origin(AllowOrigin::list(origins)),
    )
}

/// `scheme://host[:port]`, no path, no trailing slash — the exact shape a
/// browser puts in an `Origin` header, since that is what it gets compared to.
fn is_origin(value: &str) -> bool {
    let Some((scheme, rest)) = value.split_once("://") else {
        return false;
    };
    let scheme_ok = !scheme.is_empty()
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    let host_ok = !rest.is_empty() && !rest.contains('/');
    scheme_ok && host_ok
}

// ---------------------------------------------------------------- reads

async fn health(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "status": "ok", "ac": { "connected": device(&state).online } }))
}

async fn get_state(State(state): State<AppState>) -> Json<AcState> {
    let device = device(&state);
    Json(state::dto(&device.props, device.online, device.updated_at))
}

/// Ceiling on concurrent SSE streams. Each is cheap on its own, but nothing
/// else bounds them: on a 512 MB Pi the only backstop is systemd OOM-killing
/// the daemon and `Restart=always` bringing it back to be killed again. A
/// household needs a handful; anything near this is a client leaking streams or
/// someone on the LAN opening them deliberately.
const MAX_SSE_CLIENTS: usize = 32;

/// Frees its slot when the stream it rides on is dropped — a clean disconnect,
/// a phone leaving Wi-Fi, or a killed connection all land here.
struct SseSlot(Arc<AtomicUsize>);

impl Drop for SseSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

async fn events(
    State(state): State<AppState>,
) -> Result<Sse<impl Stream<Item = Result<SseEvent, Infallible>>>, ApiError> {
    // Check and claim in one atomic step: reading the count and then
    // incrementing it would let N simultaneous connections all see room for one.
    let live = state.sse_clients.clone();
    let claimed = live.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |open| {
        (open < MAX_SSE_CLIENTS).then_some(open + 1)
    });
    if claimed.is_err() {
        log::warn!("refusing SSE connection: {MAX_SSE_CLIENTS} streams already open");
        return Err(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "too many live connections".to_string(),
        ));
    }
    let slot = SseSlot(live);

    // Subscribe before reading the snapshot: an update published between the
    // two would otherwise never reach this client, and events are full
    // snapshots, so it would stay stale until the next change.
    let receiver = state.updates.subscribe();

    // Emit the current state immediately so a freshly-connected client has
    // something to render without waiting for the next change.
    let device = device(&state);
    let dto = state::dto(&device.props, device.online, device.updated_at);
    let initial = tokio_stream::once(Ok::<_, Infallible>(
        SseEvent::default().data(serde_json::to_string(&dto).unwrap_or_default()),
    ));

    let updates = BroadcastStream::new(receiver).filter_map(move |result| {
        // Owned by the stream so the slot is released exactly when the stream
        // ends, however it ends.
        let _hold = &slot;
        match result {
            Ok(payload) => Some(Ok(SseEvent::default().data(payload))),
            Err(_) => None, // lagged receiver: drop and continue (state is self-healing)
        }
    });

    Ok(Sse::new(initial.chain(updates)).keep_alive(KeepAlive::default()))
}

// --------------------------------------------------------------- writes

async fn set_power(
    State(state): State<AppState>,
    JsonBody(body): JsonBody,
) -> Result<Json<AcState>, ApiError> {
    let body = parse_body(&body)?;
    let on = body
        .get("on")
        .and_then(Value::as_bool)
        .ok_or_else(|| ApiError::bad_request("body must be { on: boolean }"))?;

    write(&state, vec![(Property::Power, i64::from(on))]).await
}

async fn set_temp(State(state): State<AppState>, JsonBody(body): JsonBody) -> Result<Json<AcState>, ApiError> {
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

async fn set_mode(State(state): State<AppState>, JsonBody(body): JsonBody) -> Result<Json<AcState>, ApiError> {
    let body = parse_body(&body)?;
    let mode = enum_field(&body, "mode", Property::Mode)?;
    write(&state, vec![(Property::Mode, mode)]).await
}

async fn set_fan(State(state): State<AppState>, JsonBody(body): JsonBody) -> Result<Json<AcState>, ApiError> {
    let body = parse_body(&body)?;
    let speed = enum_field(&body, "speed", Property::FanSpeed)?;
    write(&state, vec![(Property::FanSpeed, speed)]).await
}

async fn set_swing(State(state): State<AppState>, JsonBody(body): JsonBody) -> Result<Json<AcState>, ApiError> {
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

async fn set_option(State(state): State<AppState>, JsonBody(body): JsonBody) -> Result<Json<AcState>, ApiError> {
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
    JsonBody(body): JsonBody,
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

/// Compare a presented token against the secret without an early exit, so the
/// comparison time doesn't leak how many leading bytes matched.
fn constant_time_eq(presented: &str, secret: &str) -> bool {
    let a = presented.as_bytes();
    let b = secret.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn api_not_found() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "unknown API route".to_string())
}

async fn method_not_allowed() -> ApiError {
    ApiError(
        StatusCode::METHOD_NOT_ALLOWED,
        "method not allowed on this route".to_string(),
    )
}

/// The request body, with extractor failures mapped into the same
/// `{"error": ...}` envelope as everything else.
///
/// Taking a bare `String` lets axum answer an oversized body (413) or invalid
/// UTF-8 (400) with a bare `text/plain` line, which breaks the one contract
/// every client is told it can rely on. Going through `ApiError` here makes the
/// envelope a property of the router rather than of each handler remembering.
struct JsonBody(String);

#[async_trait]
impl<S: Send + Sync> FromRequest<S> for JsonBody {
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        String::from_request(request, state)
            .await
            .map(JsonBody)
            .map_err(|rejection: StringRejection| {
                ApiError(rejection.status(), rejection.body_text())
            })
    }
}

/// Percent-decode a query value.
///
/// `EventSource` URLs are built with `encodeURIComponent`, so a token holding
/// any reserved character arrives escaped. Comparing the raw bytes would reject
/// it with a message blaming the token. Byte-wise on purpose: slicing a `str` at
/// a percent triple can land mid-codepoint, and `panic = "abort"` would take the
/// daemon down with it.
fn percent_decode(value: &str) -> String {
    fn hex(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }

    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let decoded = match bytes[i] {
            b'%' if i + 2 < bytes.len() => hex(bytes[i + 1])
                .zip(hex(bytes[i + 2]))
                .map(|(hi, lo)| (hi << 4) | lo),
            _ => None,
        };
        match decoded {
            Some(byte) => {
                out.push(byte);
                i += 3;
            }
            None => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Writes must declare `Content-Type: application/json`. A cross-site page can
/// fire a POST with `text/plain` (or no Content-Type) as a CORS "simple
/// request" that skips preflight entirely; requiring the JSON media type moves
/// every write behind preflight, where the (absent-by-default) CORS policy
/// rejects it.
async fn require_json(request: Request, next: Next) -> Result<Response, ApiError> {
    if Method::POST == *request.method() {
        let is_json = request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .map(|essence| essence.trim().eq_ignore_ascii_case("application/json"))
            .unwrap_or(false);
        if !is_json {
            return Err(ApiError(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "Content-Type must be application/json".to_string(),
            ));
        }
    }
    Ok(next.run(request).await)
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

    // RFC 7235: the auth-scheme is case-insensitive. Matching "Bearer " exactly
    // fails closed, but it 401s a spec-compliant client with a message that
    // blames the token.
    let header_ok = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
        .map(|(_, token)| constant_time_eq(token.trim(), secret))
        .unwrap_or(false);

    // Query tokens can land in any proxy's access log, so this is scoped to the
    // one caller that has no alternative: browser `EventSource` cannot set
    // headers. Every other route takes the header only.
    let query_ok = "/api/events" == request.uri().path()
        && request
            .uri()
            .query()
            .into_iter()
            .flat_map(|q| q.split('&'))
            .filter_map(|pair| pair.strip_prefix("token="))
            .any(|value| constant_time_eq(&percent_decode(value), secret));

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
        harness_with(
            online,
            ApiConfig {
                cors_origin: None,
                token: None,
                public_dir: None,
            },
        )
    }

    fn harness_with(online: bool, config: ApiConfig) -> (Router, SentCommands) {
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
            sse_clients: Arc::new(AtomicUsize::new(0)),
        };
        (router(state, config), sent)
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
    async fn posts_without_a_json_content_type_are_rejected() {
        let (router, sent) = harness(true);

        let no_header = Request::builder()
            .method("POST")
            .uri("/api/power")
            .body(Body::from(r#"{"on":true}"#))
            .unwrap();
        let response = router.clone().oneshot(no_header).await.unwrap();
        assert_eq!(StatusCode::UNSUPPORTED_MEDIA_TYPE, response.status());
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json!("Content-Type must be application/json"), body["error"]);

        let text_plain = Request::builder()
            .method("POST")
            .uri("/api/power")
            .header(header::CONTENT_TYPE, "text/plain")
            .body(Body::from(r#"{"on":true}"#))
            .unwrap();
        let response = router.clone().oneshot(text_plain).await.unwrap();
        assert_eq!(StatusCode::UNSUPPORTED_MEDIA_TYPE, response.status());
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json!("Content-Type must be application/json"), body["error"]);

        // A rejected request must never have reached the device.
        assert!(sent.read().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_json_content_type_with_charset_is_accepted() {
        let (router, sent) = harness(true);
        let request = Request::builder()
            .method("POST")
            .uri("/api/power")
            .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
            .body(Body::from(r#"{"on":true}"#))
            .unwrap();
        let response = router.oneshot(request).await.unwrap();

        assert_eq!(StatusCode::OK, response.status());
        assert_eq!(vec![vec![(Property::Power, 1)]], *sent.read().unwrap());
    }

    #[tokio::test]
    async fn no_cors_allowance_unless_an_origin_is_allowlisted() {
        let (default_router, _) = harness(true);
        let request = Request::builder()
            .uri("/api/state")
            .header(header::ORIGIN, "http://evil.example")
            .body(Body::empty())
            .unwrap();
        let response = default_router.oneshot(request).await.unwrap();
        assert!(response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_none());

        let (allowlisted, _) = harness_with(
            true,
            ApiConfig {
                cors_origin: Some("http://localhost:5173".to_string()),
                token: None,
                public_dir: None,
            },
        );
        let request = Request::builder()
            .uri("/api/state")
            .header(header::ORIGIN, "http://localhost:5173")
            .body(Body::empty())
            .unwrap();
        let response = allowlisted.oneshot(request).await.unwrap();
        assert_eq!(
            "http://localhost:5173",
            response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN]
        );
    }

    /// `CORS_ORIGIN=*` would answer the preflight that is the only thing
    /// stopping a drive-by page from driving the AC, so it is refused outright
    /// rather than honoured.
    #[tokio::test]
    async fn a_wildcard_cors_origin_is_refused() {
        let (router, _) = harness_with(
            true,
            ApiConfig {
                cors_origin: Some("*".to_string()),
                token: None,
                public_dir: None,
            },
        );
        let request = Request::builder()
            .uri("/api/state")
            .header(header::ORIGIN, "http://evil.example")
            .body(Body::empty())
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        assert!(response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_none());
    }

    /// An entry with no scheme can never match an `Origin` header, so it is
    /// reported instead of silently producing an app that cannot call itself.
    #[tokio::test]
    async fn a_cors_entry_without_a_scheme_is_ignored() {
        assert!(cors_layer(Some("localhost:5173".to_string())).is_none());
        assert!(cors_layer(Some("http://localhost:5173".to_string())).is_some());
        // One good entry beside one bad one still configures the good one.
        assert!(cors_layer(Some("nope, http://localhost:5173".to_string())).is_some());
    }

    /// Every /api answer carries the `{"error": ...}` envelope, including the
    /// three that axum itself used to emit as bare text or an empty body.
    #[tokio::test]
    async fn every_api_failure_uses_the_error_envelope() {
        let (router, _) = harness(true);

        // GET on a POST-only route: axum's MethodNotAllowed.
        let (status, body) = call(&router, "GET", "/api/power", "").await;
        assert_eq!(StatusCode::METHOD_NOT_ALLOWED, status);
        assert_eq!(json!("method not allowed on this route"), body["error"]);

        // Body that is not valid UTF-8 is a String extractor rejection.
        let request = Request::builder()
            .method("POST")
            .uri("/api/power")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(vec![0xff, 0xfe]))
            .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        assert_eq!(StatusCode::BAD_REQUEST, response.status());
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).expect("400 body must be JSON");
        assert!(body["error"].is_string());
    }

    /// `/*rest` needs at least one segment, so these two used to fall past the
    /// API router into the static fallback — outside the token gate.
    #[tokio::test]
    async fn bare_api_paths_stay_inside_the_api_router() {
        let (router, _) = harness(true);
        for path in ["/api", "/api/", "/api/nope"] {
            let (status, body) = call(&router, "GET", path, "").await;
            assert_eq!(StatusCode::NOT_FOUND, status, "{path}");
            assert_eq!(json!("unknown API route"), body["error"], "{path}");
        }
    }

    /// RFC 7235 makes the auth-scheme case-insensitive, and a query token is
    /// accepted only for the SSE stream, which cannot send headers.
    #[tokio::test]
    async fn token_auth_accepts_any_scheme_case_and_scopes_the_query_form() {
        let secret = "s3cret";
        let router = || {
            harness_with(
                true,
                ApiConfig {
                    cors_origin: None,
                    token: Some(secret.to_string()),
                    public_dir: None,
                },
            )
            .0
        };
        let get = |uri: &'static str, auth: Option<&'static str>| {
            let mut builder = Request::builder().uri(uri);
            if let Some(value) = auth {
                builder = builder.header(header::AUTHORIZATION, value);
            }
            let request = builder.body(Body::empty()).unwrap();
            let router = router();
            async move { router.oneshot(request).await.unwrap().status() }
        };

        assert_eq!(StatusCode::OK, get("/api/state", Some("Bearer s3cret")).await);
        assert_eq!(StatusCode::OK, get("/api/state", Some("bearer s3cret")).await);
        assert_eq!(StatusCode::OK, get("/api/state", Some("BEARER s3cret")).await);
        assert_eq!(
            StatusCode::UNAUTHORIZED,
            get("/api/state", Some("Bearer wrong")).await
        );
        // Query tokens can land in a proxy log, so only the stream takes them.
        assert_eq!(
            StatusCode::UNAUTHORIZED,
            get("/api/state?token=s3cret", None).await
        );
        assert_eq!(StatusCode::OK, get("/api/events?token=s3cret", None).await);
        // encodeURIComponent output must compare equal to the raw secret.
        assert_eq!(StatusCode::OK, get("/api/events?token=s3%63ret", None).await);
        assert_eq!(
            StatusCode::UNAUTHORIZED,
            get("/api/events?atoken=s3cret", None).await
        );
    }

    #[tokio::test]
    async fn raw_properties_reject_out_of_table_and_out_of_range_values() {
        let (router, sent) = harness(true);

        let (status, body) = call(&router, "POST", "/api/properties", r#"{"mode":999}"#).await;
        assert_eq!(StatusCode::BAD_REQUEST, status);
        assert_eq!(json!("unknown property: mode=999"), body["error"]);

        let (status, body) =
            call(&router, "POST", "/api/properties", r#"{"temperature":86}"#).await;
        assert_eq!(StatusCode::BAD_REQUEST, status);
        assert_eq!(json!("temperature out of range: must be 16-30"), body["error"]);

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
