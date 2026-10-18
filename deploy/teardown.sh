#!/usr/bin/env bash
# Delete every AWS resource created by deploy/provision.sh (stops all charges).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source deploy/.state

echo "==> Terminating $INSTANCE_ID"
aws ec2 terminate-instances --region "$REGION" --instance-ids "$INSTANCE_ID" >/dev/null
aws ec2 wait instance-terminated --region "$REGION" --instance-ids "$INSTANCE_ID"

echo "==> Releasing Elastic IP $PUBLIC_IP"
aws ec2 release-address --region "$REGION" --allocation-id "$ALLOC_ID"

echo "==> Deleting security group and key pair"
aws ec2 delete-security-group --region "$REGION" --group-id "$SG_ID"
aws ec2 delete-key-pair --region "$REGION" --key-name ai-gateway
rm -f "$KEY_FILE" deploy/.state

echo "All AWS resources removed. (.env.prod is kept locally; delete it if you won't redeploy.)"
