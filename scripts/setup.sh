#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# domain-drop-watcher interactive setup wizard
# Usage: ./scripts/setup.sh [--email|--webhooks|--rotate-admin|--reconfigure|--help]
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WRANGLER_TOML="${REPO_ROOT}/wrangler.toml"
SCHEMA_SQL="${REPO_ROOT}/schema.sql"

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

MODE="full"

usage() {
  cat <<'EOF'
domain-drop-watcher setup wizard

Usage:
  ./scripts/setup.sh                 Full first-run setup
  ./scripts/setup.sh --email         Re-configure Resend email + redeploy
  ./scripts/setup.sh --webhooks      Update webhook allowlist + redeploy
  ./scripts/setup.sh --rotate-admin  Generate new ADMIN_TOKEN + redeploy
  ./scripts/setup.sh --reconfigure   Full re-run (confirms before overwriting)
  ./scripts/setup.sh --help          Show this help

Flags can only be used one at a time.
EOF
  exit 0
}

die() {
  echo -e "${RED}ERROR: ${1}${RESET}" >&2
  exit 1
}

info() {
  echo -e "${CYAN}==> ${1}${RESET}"
}

ok() {
  echo -e "${GREEN}OK  ${1}${RESET}"
}

warn() {
  echo -e "${YELLOW}WARN: ${1}${RESET}"
}

# ---- Argument parsing ---------------------------------------------------------
case "${1:-}" in
  --help|-h) usage ;;
  --email) MODE="email" ;;
  --webhooks) MODE="webhooks" ;;
  --rotate-admin) MODE="rotate-admin" ;;
  --reconfigure) MODE="reconfigure" ;;
  "") MODE="full" ;;
  *) die "Unknown flag: ${1}. Run ./scripts/setup.sh --help for usage." ;;
esac

# ---- Prerequisite checks ------------------------------------------------------
check_prerequisites() {
  info "Checking prerequisites..."

  if ! command -v wrangler &>/dev/null; then
    die "wrangler not found. Run: npm install -g wrangler  or  npm install (in repo root)"
  fi
  wrangler --version >/dev/null 2>&1 || die "wrangler --version failed"
  ok "wrangler found: $(wrangler --version 2>&1 | head -1)"

  if ! command -v jq &>/dev/null; then
    die "jq not found. Install it: brew install jq  (macOS) or  apt-get install jq (Linux)"
  fi
  ok "jq found"

  if ! command -v openssl &>/dev/null; then
    die "openssl not found. Install OpenSSL."
  fi
  ok "openssl found"
}

# ---- Cloudflare auth preflight -----------------------------------------------
cf_preflight() {
  info "Cloudflare auth preflight..."

  if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    echo ""
    echo -e "${YELLOW}No CLOUDFLARE_API_TOKEN found in this shell.${RESET}"
    echo ""
    echo "Choose an auth method:"
    echo "  [1] wrangler login  (OAuth browser flow — fine for local dev)"
    echo "  [2] Export a scoped API token in THIS shell session (recommended)"
    echo "      Create a token at: https://dash.cloudflare.com/profile/api-tokens"
    echo "      Required scopes: Workers Scripts:Edit, Workers KV Storage:Edit,"
    echo "                       D1:Edit, Account Settings:Read"
    echo ""
    read -r -p "Choice [1/2]: " AUTH_CHOICE
    case "${AUTH_CHOICE}" in
      1)
        wrangler login || die "wrangler login failed"
        ;;
      2)
        read -rs -p "Paste API token (input hidden): " CF_TOKEN_INPUT
        echo ""
        if [[ -z "${CF_TOKEN_INPUT}" ]]; then
          die "No token entered."
        fi
        export CLOUDFLARE_API_TOKEN="${CF_TOKEN_INPUT}"
        ;;
      *)
        die "Invalid choice. Exiting."
        ;;
    esac
  fi

  info "Running wrangler whoami..."
  WHOAMI_OUTPUT="$(wrangler whoami 2>&1)" || die "wrangler whoami failed. Check your Cloudflare credentials."

  ACCOUNT_NAME="$(echo "${WHOAMI_OUTPUT}" | grep -oE '"[^"]{1,80}"' | head -2 | tail -1 | tr -d '"' || true)"
  if [[ -z "${ACCOUNT_NAME}" ]]; then
    ACCOUNT_NAME="$(echo "${WHOAMI_OUTPUT}" | grep -i "account" | head -1 || echo "unknown")"
  fi

  echo ""
  echo -e "${BOLD}Deploying to account: ${ACCOUNT_NAME}${RESET}"
  read -r -p "Continue? [Y/n]: " CONFIRM_ACCOUNT
  case "${CONFIRM_ACCOUNT:-Y}" in
    [Yy]|"") ok "Continuing..." ;;
    *) echo "Aborted."; exit 0 ;;
  esac
}

# ---- wrangler.toml patching --------------------------------------------------
# Uses awk state machine: track which [[section]] block we're in, then update
# the target field only within the correct binding block.
# Validates [assets] block + run_worker_first survive.

patch_toml_field() {
  local binding_name="${1}"
  local field_name="${2}"
  local new_value="${3}"
  local section_header="${4}"

  local tmp_file
  tmp_file="$(mktemp "${WRANGLER_TOML}.XXXXXX")"

  awk -v binding="${binding_name}" \
      -v field="${field_name}" \
      -v newval="${new_value}" \
      -v section="${section_header}" \
      '
  BEGIN { in_block=0; done=0 }
  {
    if ($0 ~ "^" section) {
      in_block=1
    } else if ($0 ~ /^\[/) {
      in_block=0
    }

    if (!done && in_block && $0 ~ ("^binding *= *\"" binding "\"")) {
      found_binding=1
    }

    if (!done && in_block && found_binding && $0 ~ ("^" field " *= *")) {
      cur_val=$0
      sub(/=.*/, "", cur_val)
      gsub(/[[:space:]]/, "", cur_val)
      val=substr($0, index($0,"=")+1)
      gsub(/^[[:space:]"]+|[[:space:]"]+$/, "", val)
      if (val == "PLACEHOLDER_SET_BY_SETUP_SH") {
        print field " = \"" newval "\""
        done=1
        next
      } else {
        done=1
      }
    }
    print
  }
  ' "${WRANGLER_TOML}" > "${tmp_file}"

  if ! grep -q '\[assets\]' "${tmp_file}"; then
    rm -f "${tmp_file}"
    die "Validation failed: [assets] block missing after patching wrangler.toml"
  fi
  if ! grep -q 'run_worker_first' "${tmp_file}"; then
    rm -f "${tmp_file}"
    die "Validation failed: run_worker_first missing after patching wrangler.toml"
  fi

  mv "${tmp_file}" "${WRANGLER_TOML}"
}

patch_toml_field_force() {
  local binding_name="${1}"
  local field_name="${2}"
  local new_value="${3}"
  local section_header="${4}"

  local tmp_file
  tmp_file="$(mktemp "${WRANGLER_TOML}.XXXXXX")"

  awk -v binding="${binding_name}" \
      -v field="${field_name}" \
      -v newval="${new_value}" \
      -v section="${section_header}" \
      '
  BEGIN { in_block=0; done=0 }
  {
    if ($0 ~ "^" section) {
      in_block=1
    } else if ($0 ~ /^\[/) {
      in_block=0
    }

    if (!done && in_block && $0 ~ ("^binding *= *\"" binding "\"")) {
      found_binding=1
    }

    if (!done && in_block && found_binding && $0 ~ ("^" field " *= *")) {
      print field " = \"" newval "\""
      done=1
      next
    }
    print
  }
  ' "${WRANGLER_TOML}" > "${tmp_file}"

  if ! grep -q '\[assets\]' "${tmp_file}"; then
    rm -f "${tmp_file}"
    die "Validation failed: [assets] block missing after patching wrangler.toml"
  fi
  if ! grep -q 'run_worker_first' "${tmp_file}"; then
    rm -f "${tmp_file}"
    die "Validation failed: run_worker_first missing after patching wrangler.toml"
  fi

  mv "${tmp_file}" "${WRANGLER_TOML}"
}

is_placeholder() {
  local val="${1}"
  [[ "${val}" == "PLACEHOLDER_SET_BY_SETUP_SH" ]]
}

read_toml_field() {
  local binding_name="${1}"
  local field_name="${2}"
  local section_header="${3}"

  awk -v binding="${binding_name}" \
      -v field="${field_name}" \
      -v section="${section_header}" \
      '
  BEGIN { in_block=0; found_binding=0 }
  {
    if ($0 ~ "^" section) {
      in_block=1; found_binding=0
    } else if ($0 ~ /^\[/) {
      in_block=0
    }
    if (in_block && $0 ~ ("^binding *= *\"" binding "\"")) {
      found_binding=1
    }
    if (in_block && found_binding && $0 ~ ("^" field " *= *")) {
      val=substr($0, index($0,"=")+1)
      gsub(/^[[:space:]"]+|[[:space:]"]+$/, "", val)
      print val
      exit
    }
  }
  ' "${WRANGLER_TOML}"
}

# ---- D1 provisioning ---------------------------------------------------------
provision_d1() {
  local db_name="domain-drop-watcher"
  info "Provisioning D1 database '${db_name}'..."

  local existing_id
  existing_id="$(read_toml_field "DB" "database_id" "\[\[d1_databases\]\]")"

  if ! is_placeholder "${existing_id}" && [[ -n "${existing_id}" ]]; then
    ok "D1 database already configured in wrangler.toml: ${existing_id}"
    DB_ID="${existing_id}"
    return
  fi

  info "Listing existing D1 databases..."
  local d1_list_json
  d1_list_json="$(wrangler d1 list --json 2>/dev/null)" || d1_list_json="[]"

  local found_id
  found_id="$(echo "${d1_list_json}" | jq -r --arg name "${db_name}" '.[] | select(.name == $name) | .uuid // .database_id // ""' 2>/dev/null || true)"

  if [[ -n "${found_id}" ]]; then
    ok "Found existing D1 database: ${found_id}"
    DB_ID="${found_id}"
  else
    info "Creating D1 database '${db_name}'..."
    local create_output
    create_output="$(wrangler d1 create "${db_name}" 2>&1)"
    found_id="$(echo "${create_output}" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)"
    if [[ -z "${found_id}" ]]; then
      echo "${create_output}" >&2
      die "Could not parse D1 database UUID from wrangler output. Retry: ./scripts/setup.sh"
    fi
    ok "Created D1 database: ${found_id}"
    DB_ID="${found_id}"
  fi

  patch_toml_field "DB" "database_id" "${DB_ID}" "\[\[d1_databases\]\]"
  ok "Patched wrangler.toml: DB.database_id = ${DB_ID}"
}

# ---- KV provisioning ---------------------------------------------------------
provision_kv() {
  local binding="${1}"
  local ns_name="${2}"

  info "Provisioning KV namespace '${ns_name}' (binding: ${binding})..."

  local existing_id
  existing_id="$(read_toml_field "${binding}" "id" "\[\[kv_namespaces\]\]")"

  if ! is_placeholder "${existing_id}" && [[ -n "${existing_id}" ]]; then
    ok "KV namespace ${binding} already configured: ${existing_id}"
    return
  fi

  info "Listing existing KV namespaces..."
  local kv_list_json
  kv_list_json="$(wrangler kv:namespace list 2>/dev/null)" || kv_list_json="[]"

  local found_id
  found_id="$(echo "${kv_list_json}" | jq -r --arg title "${ns_name}" '.[] | select(.title == $title) | .id' 2>/dev/null || true)"

  if [[ -n "${found_id}" ]]; then
    ok "Found existing KV namespace: ${found_id}"
  else
    info "Creating KV namespace '${ns_name}'..."
    local create_output
    create_output="$(wrangler kv:namespace create "${ns_name}" 2>&1)"
    found_id="$(echo "${create_output}" | grep -oE '[0-9a-f]{32}' | head -1 || true)"
    if [[ -z "${found_id}" ]]; then
      found_id="$(echo "${create_output}" | grep -oE '"id":\s*"[^"]*"' | head -1 | grep -oE '"[^"]*"$' | tr -d '"' || true)"
    fi
    if [[ -z "${found_id}" ]]; then
      echo "${create_output}" >&2
      die "Could not parse KV namespace ID for '${ns_name}'. Retry: ./scripts/setup.sh"
    fi
    ok "Created KV namespace: ${found_id}"
  fi

  patch_toml_field "${binding}" "id" "${found_id}" "\[\[kv_namespaces\]\]"
  ok "Patched wrangler.toml: ${binding}.id = ${found_id}"
}

# ---- Schema apply ------------------------------------------------------------
apply_schema() {
  info "Applying schema.sql to D1 (idempotent — IF NOT EXISTS)..."
  wrangler d1 execute domain-drop-watcher --file="${SCHEMA_SQL}" --remote 2>&1 | tail -5
  ok "Schema applied"
}

# ---- Admin token -------------------------------------------------------------
generate_admin_token() {
  info "Generating ADMIN_TOKEN..."
  local token
  token="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"

  echo ""
  echo -e "${BOLD}${YELLOW}============================================================${RESET}"
  echo -e "${BOLD}${YELLOW}  ADMIN TOKEN — SAVE THIS NOW — NOT SHOWN AGAIN${RESET}"
  echo -e "${BOLD}${YELLOW}============================================================${RESET}"
  echo ""
  echo -e "${BOLD}  ${token}${RESET}"
  echo ""
  echo -e "${YELLOW}  Recovery: ./scripts/setup.sh --rotate-admin${RESET}"
  echo -e "${BOLD}${YELLOW}============================================================${RESET}"
  echo ""
  read -r -p "Press ENTER after you have saved the token to continue: "

  printf '%s' "${token}" | wrangler secret put ADMIN_TOKEN
  verify_secret "ADMIN_TOKEN"
  ADMIN_TOKEN_VALUE="${token}"
}

rotate_admin_token() {
  info "Rotating ADMIN_TOKEN..."
  local token
  token="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"

  echo ""
  echo -e "${BOLD}${YELLOW}============================================================${RESET}"
  echo -e "${BOLD}${YELLOW}  NEW ADMIN TOKEN — SAVE THIS NOW — NOT SHOWN AGAIN${RESET}"
  echo -e "${BOLD}${YELLOW}============================================================${RESET}"
  echo ""
  echo -e "${BOLD}  ${token}${RESET}"
  echo ""
  echo -e "${YELLOW}  Previous token is now invalid.${RESET}"
  echo -e "${BOLD}${YELLOW}============================================================${RESET}"
  echo ""
  read -r -p "Press ENTER after you have saved the token to continue: "

  printf '%s' "${token}" | wrangler secret put ADMIN_TOKEN
  verify_secret "ADMIN_TOKEN"
  ADMIN_TOKEN_VALUE="${token}"
}

# ---- Secret verification ------------------------------------------------------
verify_secret() {
  local binding="${1}"
  info "Verifying secret upload: ${binding}..."

  local secret_list
  secret_list="$(wrangler secret list --format json 2>/dev/null || wrangler secret list 2>/dev/null || echo "[]")"

  if echo "${secret_list}" | grep -q "\"${binding}\""; then
    ok "Secret ${binding} confirmed present"
  else
    echo -e "${RED}Secret ${binding} NOT found in wrangler secret list.${RESET}" >&2
    echo "Resume command depends on which secret failed:" >&2
    echo "  Admin token: ./scripts/setup.sh --rotate-admin" >&2
    echo "  Email:       ./scripts/setup.sh --email" >&2
    echo "  Webhooks:    ./scripts/setup.sh --webhooks" >&2
    exit 1
  fi
}

# ---- Email (Resend) setup ----------------------------------------------------
setup_email() {
  echo ""
  echo "Email alerts require a verified sending domain (SPF + DKIM DNS records)."
  echo "You can skip this now and use Teams/Slack/Discord webhooks instead."
  echo "Re-run later with:  ./scripts/setup.sh --email"
  echo ""
  read -r -p "Configure email alerts via Resend? [y/N]: " WANT_EMAIL
  case "${WANT_EMAIL:-N}" in
    [Yy]) ;;
    *) info "Skipping email setup."; return ;;
  esac

  echo ""
  echo "Step 1: Create a Resend account (if you don't have one):"
  echo "  https://resend.com/signup"
  if command -v open &>/dev/null; then
    read -r -p "Open signup page in browser? [y/N]: " OPEN_SIGNUP
    case "${OPEN_SIGNUP:-N}" in
      [Yy]) open "https://resend.com/signup" ;;
    esac
  fi

  echo ""
  echo "Step 2: Add and verify your sending domain:"
  echo "  https://resend.com/domains"
  echo ""
  echo "Add these DNS records to your domain:"
  echo "  Type: TXT  (SPF record — validates sending server)"
  echo "  Type: TXT  (DKIM record — validates message signature)"
  echo "  (Resend shows the exact values after you add your domain)"
  echo ""
  if command -v open &>/dev/null; then
    read -r -p "Open domains page in browser? [y/N]: " OPEN_DOMAINS
    case "${OPEN_DOMAINS:-N}" in
      [Yy]) open "https://resend.com/domains" ;;
    esac
  fi

  echo ""
  read -r -p "Press ENTER once your domain shows 'Verified' in the Resend dashboard..."

  echo ""
  read -rs -p "Resend API key (input hidden): " RESEND_KEY
  echo ""
  if [[ -z "${RESEND_KEY}" ]]; then
    warn "No API key entered. Skipping email setup."
    warn "Resume: ./scripts/setup.sh --email"
    return
  fi

  printf '%s' "${RESEND_KEY}" | wrangler secret put RESEND_API_KEY
  verify_secret "RESEND_API_KEY"

  local from_address=""
  local email_regex='^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
  while true; do
    read -r -p "From address for alerts (e.g. alerts@yourdomain.com): " from_address
    if [[ "${from_address}" =~ ${email_regex} ]]; then
      break
    fi
    warn "Invalid email format. Try again."
  done

  printf '%s' "${from_address}" | wrangler secret put RESEND_FROM_ADDRESS
  verify_secret "RESEND_FROM_ADDRESS"

  info "Sending test email to verify configuration..."
  local test_to=""
  read -r -p "Test recipient email address: " test_to
  if [[ -z "${test_to}" ]]; then
    warn "No test recipient. Skipping test send."
  else
    send_test_email "${RESEND_KEY}" "${from_address}" "${test_to}"
  fi
}

send_test_email() {
  local api_key="${1}"
  local from="${2}"
  local to="${3}"

  local payload
  payload="$(printf '{"from":"%s","to":["%s"],"subject":"domain-drop-watcher test","html":"<p>Setup wizard test email. Your email alerts are configured.</p>"}' "${from}" "${to}")"

  local response http_code
  local tmp_response
  tmp_response="$(mktemp)"

  http_code="$(curl -fsS -o "${tmp_response}" -w "%{http_code}" \
    -X POST "https://api.resend.com/emails" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${api_key}" \
    -d "${payload}" 2>&1)" || true

  response="$(cat "${tmp_response}")"
  rm -f "${tmp_response}"

  if [[ "${http_code}" =~ ^2 ]]; then
    ok "Test email sent (HTTP ${http_code})"
  else
    warn "Test email failed (HTTP ${http_code}):"
    echo "${response}" >&2
    read -r -p "Retry email setup? [y/N]: " RETRY_EMAIL
    case "${RETRY_EMAIL:-N}" in
      [Yy]) setup_email ;;
      *) warn "Email skipped. Resume: ./scripts/setup.sh --email" ;;
    esac
  fi
}

# ---- Webhook allowlist --------------------------------------------------------
setup_webhooks() {
  local default_allowlist="*.webhook.office.com,hooks.slack.com,discord.com,discordapp.com"
  echo ""
  echo "Current default webhook allowlist:"
  echo "  ${default_allowlist}"
  echo ""
  echo "This covers Teams, Slack, and Discord webhooks."
  echo "Add custom hosts (glob patterns) for other webhook targets."
  echo ""
  read -r -p "Add custom webhook hosts? [y/N]: " WANT_CUSTOM
  case "${WANT_CUSTOM:-N}" in
    [Yy]) ;;
    *)
      info "Using default allowlist."
      printf '%s' "${default_allowlist}" | wrangler secret put WEBHOOK_HOST_ALLOWLIST
      verify_secret "WEBHOOK_HOST_ALLOWLIST"
      return
      ;;
  esac

  local allowlist="${default_allowlist}"
  local glob_regex='^[A-Za-z0-9*._-]+(\.[A-Za-z0-9*._-]+)+$'
  echo "Enter additional hosts one per line (empty line to finish)."
  echo "Examples: mywebhook.example.com  or  *.myservice.io"
  echo ""
  while true; do
    read -r -p "Host (or ENTER to finish): " extra_host
    if [[ -z "${extra_host}" ]]; then
      break
    fi
    if [[ "${extra_host}" =~ ${glob_regex} ]]; then
      allowlist="${allowlist},${extra_host}"
      ok "Added: ${extra_host}"
    else
      warn "Invalid host pattern '${extra_host}' — skipping."
    fi
  done

  printf '%s' "${allowlist}" | wrangler secret put WEBHOOK_HOST_ALLOWLIST
  verify_secret "WEBHOOK_HOST_ALLOWLIST"
  ok "Allowlist set: ${allowlist}"
}

# ---- Deploy + smoke test ------------------------------------------------------
deploy_and_verify() {
  info "Running wrangler deploy..."
  local deploy_output
  deploy_output="$(wrangler deploy 2>&1)"
  echo "${deploy_output}" | tail -20

  local worker_url
  worker_url="$(echo "${deploy_output}" | grep -oE 'https://[a-z0-9-]+\.workers\.dev' | head -1 || true)"

  if [[ -z "${worker_url}" ]]; then
    warn "Could not auto-detect worker URL from deploy output."
    read -r -p "Enter worker URL manually (e.g. https://domain-drop-watcher.example.workers.dev): " worker_url
    worker_url="${worker_url%/}"
  fi

  info "Verifying /health endpoint at ${worker_url}/health ..."
  local health_response
  health_response="$(curl -fsS "${worker_url}/health" 2>&1)" || {
    warn "Health check failed. The worker may still be propagating. Try:"
    echo "  curl '${worker_url}/health'"
    return
  }
  ok "Health check passed: ${health_response}"

  echo ""
  echo -e "${BOLD}${GREEN}============================================================${RESET}"
  echo -e "${BOLD}${GREEN}  domain-drop-watcher deployed successfully!${RESET}"
  echo -e "${BOLD}${GREEN}============================================================${RESET}"
  echo ""
  echo -e "  Worker URL:      ${BOLD}${worker_url}${RESET}"
  echo -e "  Dashboard:       ${BOLD}${worker_url}/${RESET}"
  if [[ -n "${ADMIN_TOKEN_VALUE:-}" ]]; then
    echo -e "  Admin token:     ${BOLD}(saved above — not shown again)${RESET}"
  fi
  echo ""
  echo "  Add domains:"
  echo "    curl -X POST '${worker_url}/domains' \\"
  echo "      -H 'Authorization: Bearer \$ADMIN_TOKEN' \\"
  echo "      -H 'Content-Type: application/json' \\"
  echo "      -d '{\"fqdn\":\"example.com\",\"notifyOn\":[\"available\"]}'"
  echo ""
  echo -e "${BOLD}${GREEN}============================================================${RESET}"
}

# ---- Main flow ---------------------------------------------------------------
ADMIN_TOKEN_VALUE=""

case "${MODE}" in
  full)
    check_prerequisites
    cf_preflight
    provision_d1
    provision_kv "EVENTS" "domain-drop-watcher-events"
    provision_kv "BOOTSTRAP" "domain-drop-watcher-bootstrap"
    apply_schema
    generate_admin_token
    setup_email
    setup_webhooks
    deploy_and_verify
    ;;

  email)
    check_prerequisites
    cf_preflight
    setup_email
    deploy_and_verify
    ;;

  webhooks)
    check_prerequisites
    cf_preflight
    setup_webhooks
    deploy_and_verify
    ;;

  rotate-admin)
    check_prerequisites
    cf_preflight
    rotate_admin_token
    deploy_and_verify
    ;;

  reconfigure)
    echo ""
    echo -e "${YELLOW}This will re-run full setup and overwrite existing secrets.${RESET}"
    read -r -p "Are you sure you want to reconfigure from scratch? [y/N]: " CONFIRM_RECONFIG
    case "${CONFIRM_RECONFIG:-N}" in
      [Yy]) ;;
      *) echo "Aborted."; exit 0 ;;
    esac
    check_prerequisites
    cf_preflight
    provision_d1
    provision_kv "EVENTS" "domain-drop-watcher-events"
    provision_kv "BOOTSTRAP" "domain-drop-watcher-bootstrap"
    apply_schema
    rotate_admin_token
    setup_email
    setup_webhooks
    deploy_and_verify
    ;;
esac
