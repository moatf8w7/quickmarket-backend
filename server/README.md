# Quick Market API

The API uses Express and the synchronous `better-sqlite3` module in `src/db`.
Run the server from the project root with `npm run dev:server` or use the
root-level start script documented in the main README. The server initializes
the persistent SQLite database on startup and serves `client/dist` when a
production client build is present.

## Configuration

Set these values in the project `.env` file before deployment:

- `PORT`: HTTP port (defaults to `3000`).
- `SESSION_SECRET`: long, random signing key for customer and admin sessions.
- `SQLITE_DB_PATH`: optional database file location. Defaults to
  `server/data/market-sama.sqlite`.
- `CORS_ORIGIN`: comma-separated frontend origins for production.
- `TRUST_PROXY=true`: enable only when the app is behind a trusted reverse proxy.

The seeded local administrator is `admin` / `admin123`. Change that credential
before exposing the admin surface to a network. Customers sign in with their
name and Syrian phone number; this demo does not implement OTP verification.

## API overview

- `GET /api/storefront`: active categories and products, offers, and store settings.
- `POST /api/auth/session`: create or resume a customer session.
- `GET|PUT /api/account`: read or update the signed-in customer's profile.
- `GET /api/account/orders`: list that customer's orders.
- `/api/account/addresses`: customer-owned address list and CRUD.
- `POST /api/account/wallet/convert`: convert loyalty points to spendable wallet balance.
- `POST /api/orders`: create a COD or Cham Cash order.
- `POST /api/orders/:id/receipt`: attach a Cham Cash transfer receipt image.
- `GET /api/track/:code`: public order progress lookup.
- `POST /api/admin/session`: administrator login; all remaining `/api/admin` routes require a signed admin token.
- `/api/admin/dashboard`, `/categories`, `/products`, `/settings`, and `/orders`: admin overview and management.
- `POST /api/admin/orders/:id/dispatch`: generate a local mock delivery manifest.

Protected routes accept `Authorization: Bearer <token>`. Successful responses
are JSON; validation errors use `{ "error": "...", "code": "..." }`.
Payment receipt and uploaded image inputs use JSON data URLs. The image
enhancement and delivery-manifest integrations are local mock boundaries, ready
to be connected to real providers.
