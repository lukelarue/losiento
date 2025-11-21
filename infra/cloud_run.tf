resource "google_project_service" "run" {
  project            = var.project_id
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

locals {
  image = "${var.artifact_registry_location}-docker.pkg.dev/${var.project_id}/losiento/losiento:${var.image_tag}"
}

resource "google_cloud_run_service" "losiento" {
  name                       = "losiento"
  location                   = var.cloud_run_location
  autogenerate_revision_name = true

  template {
    metadata {
      annotations = {
        "autoscaling.knative.dev/minScale" = "0"
        "autoscaling.knative.dev/maxScale" = "3"
      }
    }

    spec {
      service_account_name = google_service_account.losiento_runtime.email

      containers {
        image = local.image

        ports {
          name           = "http1"
          container_port = 8080
        }

        env {
          name  = "GOOGLE_CLOUD_PROJECT"
          value = var.project_id
        }

        env {
          name  = "USE_INMEMORY"
          value = "0"
        }

        env {
          name  = "ALLOW_ANON"
          value = "0"
        }

        env {
          name  = "TRUST_X_USER_ID"
          value = "1"
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].spec[0].containers[0].image,
    ]
  }

  traffic {
    percent         = 100
    latest_revision = true
  }

  depends_on = [
    google_project_service.run,
    google_service_account.losiento_runtime,
  ]
}

resource "google_cloud_run_service_iam_member" "losiento_public" {
  service  = google_cloud_run_service.losiento.name
  location = google_cloud_run_service.losiento.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "losiento_service_url" {
  description = "Cloud Run URL for the Lo Siento service"
  value       = google_cloud_run_service.losiento.status[0].url
}
