variable "environment" {
  description = "Environment name"
  type        = string
}

variable "origins_key" {
  description = "S3 key for the origins JSON file"
  type        = string
  default     = "cors/allowed-origins.json"
}

variable "static_origins" {
  description = "Static platform origins to include"
  type        = list(string)
  default = [
    "https://chalk.q9labs.ai",
    "https://chalk-5bc.pages.dev",
    "https://collabdash-dev.vercel.app",
    "https://app.collabdash.io",
    "https://dev.dwd4jsk5p7j52.amplifyapp.com",
    "https://portal-dev.tuitionhighway.com",
    "https://portal.tuitionhighway.com",
    "https://backend.tuitionhighway.com",
    "https://backend-dev.tuitionhighway.com"
  ]
}

variable "tags" {
  description = "Additional tags"
  type        = map(string)
  default     = {}
}
