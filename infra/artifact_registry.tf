resource "google_project_service" "artifactregistry" {
  project            = var.project_id
  service            = "artifactregistry.googleapis.com"
  disable_on_destroy = false
}

data "google_project" "current" {
  project_id = var.project_id
}

resource "google_artifact_registry_repository" "losiento" {
  project       = var.project_id
  location      = var.artifact_registry_location
  repository_id = "losiento"
  description   = "Docker images for the Lo Siento Cloud Run service."
  format        = "DOCKER"
  mode          = "STANDARD_REPOSITORY"

  labels = {
    managed_by  = "terraform"
    environment = "prod"
    application = "lukelarue"
    service     = "losiento"
  }

  depends_on = [google_project_service.artifactregistry]
}

resource "google_artifact_registry_repository_iam_member" "cloud_run_pull" {
  project    = var.project_id
  location   = google_artifact_registry_repository.losiento.location
  repository = google_artifact_registry_repository.losiento.repository_id
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:service-${data.google_project.current.number}@serverless-robot-prod.iam.gserviceaccount.com"
}

resource "google_artifact_registry_repository_iam_member" "runtime_can_pull" {
  project    = var.project_id
  location   = google_artifact_registry_repository.losiento.location
  repository = google_artifact_registry_repository.losiento.repository_id
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.losiento_runtime.email}"
}

output "artifact_registry_repository_id" {
  description = "Artifact Registry repository resource ID for Lo Siento."
  value       = google_artifact_registry_repository.losiento.id
}
