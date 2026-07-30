# Remote state location. Not secret — the bucket is private and access is IAM
# controlled; this file only names it so `terraform init` is one command.
bucket = "deehub-hotel-tfstate"
prefix = "prod"
