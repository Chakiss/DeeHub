variable "project_id" {
  description = "Google Cloud project."
  type        = string
}

variable "region" {
  description = "Deployment region. asia-southeast1 (Singapore) is the closest to Thailand."
  type        = string
  default     = "asia-southeast1"
}

variable "environment" {
  description = "Environment name, used as a resource suffix."
  type        = string
  default     = "prod"
}

variable "db_tier" {
  # db-g1-small is the smallest tier that is not shared-core; it is enough for a
  # handful of pilot properties and is trivially resizable later.
  description = "Cloud SQL machine tier."
  type        = string
  default     = "db-g1-small"
}

variable "redis_memory_gb" {
  description = "Memorystore size. BullMQ queues are tiny; 1GB is generous."
  type        = number
  default     = 1
}

variable "api_image" {
  description = "Fully qualified API image. Set by CI on each deploy."
  type        = string
}

variable "web_image" {
  description = "Fully qualified dashboard image. Set by CI on each deploy."
  type        = string
}

variable "cors_origins" {
  description = "Origins allowed to call the API directly."
  type        = string
  default     = ""
}
