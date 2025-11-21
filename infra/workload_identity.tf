resource "google_project_service" "iamcredentials" {
  project            = var.project_id
  service            = "iamcredentials.googleapis.com"
  disable_on_destroy = false
}

resource "google_iam_workload_identity_pool_provider" "github_repository" {
  workload_identity_pool_id          = "github-actions"
  workload_identity_pool_provider_id = "lukelarue-losiento"
  display_name                       = "lukelarue/losiento"
  description                        = "GitHub Actions provider for lukelarue/losiento"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.actor"      = "assertion.actor"
    "attribute.workflow"   = "assertion.workflow"
  }

  attribute_condition = "attribute.repository == \"${var.github_repository}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "deploy_wif" {
  service_account_id = google_service_account.losiento_deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/projects/${data.google_project.current.number}/locations/global/workloadIdentityPools/github-actions/attribute.repository/${var.github_repository}"
}

resource "google_service_account_iam_member" "deploy_token_creator" {
  service_account_id = google_service_account.losiento_deploy.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "principalSet://iam.googleapis.com/projects/${data.google_project.current.number}/locations/global/workloadIdentityPools/github-actions/attribute.repository/${var.github_repository}"
}

output "workload_identity_provider_name" {
  value = google_iam_workload_identity_pool_provider.github_repository.name
}
