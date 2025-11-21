# Lo Siento Infra (Terraform)

This package provisions the Google Cloud resources needed to build and run **Lo Siento**:

- Artifact Registry repository `losiento`
- Cloud Run service `losiento` (port 8080 inside the container)
- Runtime and Deploy service accounts with least-privileged roles
- Workload Identity Federation provider for this repo (`lukelarue/losiento`)

## Prerequisites

- GCP project with billing enabled and Firestore already initialized (Native mode)
- Authenticated with gcloud and Application Default Credentials:
  - `gcloud auth application-default login`
- Terraform state bucket `lukelarue-terraform-state` exists

## Variables

- `project_id` (default: `parabolic-env-456611-q9`)
- `artifact_registry_location` (default: `us-central1`)
- `cloud_run_location` (default: `us-central1`)
- `github_repository` (default: `lukelarue/losiento`)
- `image_tag` (default: `latest`)

## Apply

```bash
terraform -chdir=infra init
terraform -chdir=infra apply
```

### Outputs

- `losiento_service_url` – Cloud Run URL to embed in the website lobby iframe
- `workload_identity_provider_name` – Use as `GCP_WORKLOAD_IDENTITY_PROVIDER` in this repo's GitHub Variables
- `losiento_deploy_sa_email` – Use as `GCP_DEPLOY_SA_EMAIL` in this repo's GitHub Variables

## GitHub Variables (this repo)

Set these in GitHub Repository **Variables** for `lukelarue/losiento`:

- `GCP_PROJECT_ID` = your GCP project id (e.g. `parabolic-env-456611-q9`)
- `GCP_WORKLOAD_IDENTITY_PROVIDER` = value from `workload_identity_provider_name` output
- `GCP_DEPLOY_SA_EMAIL` = value from `losiento_deploy_sa_email` output
- `GCP_ARTIFACT_REGISTRY_HOST` = `us-central1-docker.pkg.dev`
- `CLOUD_RUN_REGION` = `us-central1`

## Website embedding (lukelaruecom)

The main site (`lukelaruecom`) embeds Lo Siento in the lobby via an iframe. The lobby page reads the Lo Siento URL from `env.losientoUrl`, which is derived from `VITE_LOSIENTO_URL` in the website build.

- In the website repo, set `VITE_LOSIENTO_URL` (repository variable) to the Cloud Run URL from `losiento_service_url`.
- The lobby will then load Lo Siento in an iframe at that URL.

For local development with the unified stack, the website's `.env` typically includes something like:

```env
VITE_LOSIENTO_URL=http://localhost:8001
```

matching the port used by the local Lo Siento dev server.

## Firestore data model and how it is used

The Lo Siento service persists lobby and game state in Firestore (Native mode). The schema is multi-player and game-centric:

- `losiento_games/{gameId}` (collection)
  - One document per game (lobby or active).
  - Fields include:
    - `hostId`, `hostName`
    - `phase` (`"lobby" | "active" | "finished" | "aborted"`)
    - `settings` (e.g. `maxSeats`, optional deck seed)
    - `seats` array (per-seat player/bot configuration and status)
    - `state` for active games (turn number, current seat, deck, discard pile, board, winner, result)
    - timestamps such as `createdAt`, `updatedAt`, `endedAt`

- `losiento_games/{gameId}/moves/{moveId}` (subcollection)
  - Append-only move history for that game.
  - Fields include:
    - `index` (0, 1, 2, ...)
    - `seatIndex`, `playerId`
    - `card` (`"1"`, `"2"`, `"7"`, `"Sorry!"`, etc.)
    - `moveData` describing the move (pawns, directions, steps, bumps, slides)
    - `resultingStateHash` for debugging
    - `createdAt`

- Optional `losiento_users/{userId}`
  - Convenience mapping to track a user's `activeGameId`.
  - Used to enforce "one active game at a time" per user and to let users rejoin games.

### Per-user identity and headers

As with Minesweeper, the backend derives a stable user ID from request headers and uses it consistently for Firestore lookups. In production (Cloud Run), it prefers trusted Google/IAP-style headers and disables anonymous fallbacks by default.

Order of precedence in `app/main.py`:

1. `X-Goog-Authenticated-User-Email` or `X-Authenticated-User-Email` or `X-Forwarded-Email` (e.g. `accounts.google.com:alice@example.com` → `alice@example.com`)
2. `X-Forwarded-User`
3. `X-User-Id` only if `TRUST_X_USER_ID=1` (intended for trusted frontends / tests)
4. Anonymous fallback only if `ALLOW_ANON=1` (dev convenience)

Environment flags influencing behavior:

- `USE_INMEMORY` – when `1`, use in-memory persistence instead of Firestore (Cloud Run sets this to `0` so production uses Firestore).
- `TRUST_X_USER_ID` – whether to trust the `X-User-Id` header.
- `ALLOW_ANON` – whether to allow anonymous fallback with `DEFAULT_USER_ID`.
- `DEFAULT_USER_ID` – default local user id when anonymous fallback is enabled.
- `FIRESTORE_EMULATOR_HOST` – when set, the service connects to the Firestore emulator instead of the production database.
- `GOOGLE_CLOUD_PROJECT` – Firestore project id to use.

Because each request is resolved to a specific user ID and games are keyed by `gameId` plus per-user mappings in `losiento_users/{userId}`, the backend enforces that users can only host/join/play in games where they are participants, while bots and other seats are managed server-side.
