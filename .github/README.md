# Lo Siento CI/CD Strategy

## Overview

Lo Siento is intended to use the **same CI/CD pattern** as Minesweeper:

- Terraform under `infra/` provisions Artifact Registry, Cloud Run `losiento`, service accounts, and a Workload Identity Federation (WIF) provider for this repo.
- GitHub Actions builds, tests, and publishes a Docker image to Artifact Registry, then deploys a **pinned digest** to Cloud Run.
- Terraform's Cloud Run resource uses `lifecycle.ignore_changes` on the image field so Terraform owns the service shape while GitHub Actions owns the rollout of new container images.

At the moment, the workflows in `.github/workflows/` are **fully commented out**. They are present as a reference/template and do not run until you remove the leading `#` prefixes.

## Planned workflows

### `.github/workflows/tests.yml` (commented out)

- **Trigger (when enabled)**
  - `on: push`
  - `on: workflow_dispatch`
- **Purpose**
  - Fast feedback on lint and unit tests for Lo Siento.
- **Intended steps**
  - Checkout repo.
  - Set up Python 3.11.
  - Install dependencies from `requirements.txt` and `ruff`.
  - Run `ruff check .`.
  - Run unit tests, e.g. `python -m unittest` against `losiento/tests/`.

### `.github/workflows/image-publish.yml` (commented out)

- **Trigger (when enabled)**
  - Pushes to `main` that touch:
    - `app/**`, `losiento_game/**`, `frontend/**`
    - `Dockerfile`, `requirements.txt`
    - The workflow file itself.
  - Manual `workflow_dispatch`.
- **Intended jobs**
  - **`test` job**
    - Mirrors the tests workflow:
      - Python lint (`ruff`) and unit tests on the source tree.
    - Builds a Docker image using the repo `Dockerfile` (tagged `losiento:ci`).
    - Uses Node + `firebase-tools` to run the tests **inside the Docker image** under a Firestore emulator (`emulators:exec --only firestore ...`).
  - **`build-and-deploy` job**
    - Runs only after `test` passes.
    - Verifies that required GitHub repository variables are present:
      - `GCP_PROJECT_ID`
      - `GCP_WORKLOAD_IDENTITY_PROVIDER`
      - `GCP_DEPLOY_SA_EMAIL`
      - `ARTIFACT_REGISTRY_HOST`
      - `CLOUD_RUN_REGION`
    - Authenticates to Google Cloud via Workload Identity Federation using `google-github-actions/auth@v2` and the deploy service account.
    - Logs into Artifact Registry with `docker/login-action@v3`.
    - Builds and pushes the Lo Siento image with `docker/build-push-action@v5` to:
      - `${ARTIFACT_REGISTRY_HOST}/${GCP_PROJECT_ID}/losiento/losiento:${GITHUB_SHA}`
      - `${ARTIFACT_REGISTRY_HOST}/${GCP_PROJECT_ID}/losiento/losiento:latest`
    - Deploys to Cloud Run with `google-github-actions/deploy-cloudrun@v2`:
      - Service name: `losiento`
      - Region: `${CLOUD_RUN_REGION}`
      - Image: pushed Artifact Registry image pinned by digest.
    - Writes a brief deployment summary (image and digest) to `$GITHUB_STEP_SUMMARY`.

## Required GitHub repository variables

Once Terraform `infra/` has been applied, configure these variables in **Repository Settings → Variables** for `lukelarue/losiento`:

- `GCP_PROJECT_ID` – target GCP project (matches `var.project_id`, default `parabolic-env-456611-q9`).
- `GCP_WORKLOAD_IDENTITY_PROVIDER` – value from Terraform output `workload_identity_provider_name` in `infra/workload_identity.tf`.
- `GCP_DEPLOY_SA_EMAIL` – value from Terraform output `losiento_deploy_sa_email` in `infra/service_accounts.tf`.
- `ARTIFACT_REGISTRY_HOST` – e.g. `us-central1-docker.pkg.dev` (matches `artifact_registry_location`).
- `CLOUD_RUN_REGION` – e.g. `us-central1` (matches `cloud_run_location`).

## Terraform vs CI ownership

- **Terraform (`infra/`)** provisions:
  - Artifact Registry repo `losiento`.
  - Cloud Run service `losiento` (port 8080) with runtime configuration.
  - Runtime and deploy service accounts and IAM roles.
  - Workload Identity Federation provider bound to `lukelarue/losiento`.
- **GitHub Actions** (when workflows are enabled):
  - Builds and pushes new Lo Siento container images.
  - Deploys new Cloud Run revisions using pinned digests (CI is the deployment owner for the image).

Because the Cloud Run image field is ignored by Terraform, you can:

- Use Terraform to evolve infra (IAM, scaling, env vars, etc.) without affecting which image is deployed.
- Use GitHub Actions (pushes to `main`) to roll out new application versions without causing Terraform drift.

## Enabling the workflows

To turn this CI/CD on for Lo Siento:

1. Apply Terraform in `infra/` so the Artifact Registry, Cloud Run service, service accounts, and WIF provider exist.
2. Set the repository variables listed above.
3. Edit `.github/workflows/tests.yml` and `.github/workflows/image-publish.yml` to remove the leading `#` comment markers.
4. Commit and push to `main`.

From that point, pushes to `main` will build, test, publish, and deploy Lo Siento in the same way Minesweeper is deployed.
