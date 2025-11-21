locals {
  runtime_roles = [
    "roles/datastore.user",
    "roles/logging.logWriter",
  ]

  deploy_roles = [
    "roles/run.admin",
    "roles/artifactregistry.writer",
  ]
}

resource "google_service_account" "losiento_runtime" {
  account_id   = "losiento-runtime"
  display_name = "Lo Siento Cloud Run runtime"
}

resource "google_service_account" "losiento_deploy" {
  account_id   = "losiento-deploy"
  display_name = "Lo Siento CI/CD deploy automation"
}

resource "google_project_iam_member" "runtime_roles" {
  for_each = toset(local.runtime_roles)

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.losiento_runtime.email}"
}

resource "google_project_iam_member" "deploy_roles" {
  for_each = toset(local.deploy_roles)

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.losiento_deploy.email}"
}

resource "google_service_account_iam_member" "deploy_can_use_runtime" {
  service_account_id = google_service_account.losiento_runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.losiento_deploy.email}"
}

output "losiento_runtime_sa_email" {
  value = google_service_account.losiento_runtime.email
}

output "losiento_deploy_sa_email" {
  value = google_service_account.losiento_deploy.email
}
