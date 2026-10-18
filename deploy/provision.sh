#!/usr/bin/env bash
# Create the AWS resources for a single-host deployment:
#   key pair, security group (80/443 public, 22 from your IP), t3.small, Elastic IP.
# Everything is tagged Project=ai-gateway. Remove it all with deploy/teardown.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME=ai-gateway
REGION=${AWS_REGION:-$(aws configure get region)}
INSTANCE_TYPE=${INSTANCE_TYPE:-t3.small}
KEY_FILE="$HOME/.ssh/$NAME.pem"
STATE=deploy/.state
TAGS="Key=Project,Value=$NAME"

if [ -f "$STATE" ]; then
  echo "Already provisioned ($STATE exists). Run deploy/teardown.sh first to start over."
  exit 1
fi

MY_IP=$(curl -fsS https://checkip.amazonaws.com)
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)
# MSYS_NO_PATHCONV: stop Git Bash on Windows rewriting /aws/... into a file path
AMI_ID=$(MSYS_NO_PATHCONV=1 aws ssm get-parameter --region "$REGION" \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query 'Parameter.Value' --output text)

echo "==> Key pair"
mkdir -p "$HOME/.ssh"
aws ec2 create-key-pair --region "$REGION" --key-name "$NAME" --key-type ed25519 \
  --tag-specifications "ResourceType=key-pair,Tags=[{$TAGS}]" \
  --query 'KeyMaterial' --output text | tr -d '\r' > "$KEY_FILE"  # AWS CLI on Windows emits CRLF
chmod 600 "$KEY_FILE"

echo "==> Security group"
SG_ID=$(aws ec2 create-security-group --region "$REGION" --group-name "$NAME" \
  --description "AI Gateway: HTTP/HTTPS public, SSH from admin IP" --vpc-id "$VPC_ID" \
  --tag-specifications "ResourceType=security-group,Tags=[{$TAGS}]" \
  --query 'GroupId' --output text)
aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" --ip-permissions \
  "IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0}]" \
  "IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]" \
  "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$MY_IP/32,Description=admin}]" >/dev/null

echo "==> Instance ($INSTANCE_TYPE, $AMI_ID)"
INSTANCE_ID=$(aws ec2 run-instances --region "$REGION" --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" --key-name "$NAME" --security-group-ids "$SG_ID" \
  --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=20,VolumeType=gp3}' \
  --metadata-options 'HttpTokens=required' \
  --user-data file://deploy/userdata.sh \
  --tag-specifications "ResourceType=instance,Tags=[{$TAGS},{Key=Name,Value=$NAME}]" \
  --query 'Instances[0].InstanceId' --output text)
aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"

echo "==> Elastic IP"
read -r ALLOC_ID PUBLIC_IP < <(aws ec2 allocate-address --region "$REGION" --domain vpc \
  --tag-specifications "ResourceType=elastic-ip,Tags=[{$TAGS}]" \
  --query '[AllocationId,PublicIp]' --output text | tr -d '\r')
aws ec2 associate-address --region "$REGION" --instance-id "$INSTANCE_ID" --allocation-id "$ALLOC_ID" >/dev/null

cat > "$STATE" <<EOF
REGION=$REGION
INSTANCE_ID=$INSTANCE_ID
SG_ID=$SG_ID
ALLOC_ID=$ALLOC_ID
PUBLIC_IP=$PUBLIC_IP
KEY_FILE=$KEY_FILE
EOF

echo
echo "Provisioned $INSTANCE_ID at $PUBLIC_IP (state in $STATE)."
echo "Next: deploy/deploy.sh"
