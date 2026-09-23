<#
  Stores the three Stripe values as Supabase secrets for the billing Edge Functions.

  Run this YOURSELF, in your own terminal, from the repo root:
      powershell -ExecutionPolicy Bypass -File tools\set_stripe_secrets.ps1

  - Each value is typed at a hidden prompt: it is not echoed, not logged, not written to any
    file that survives this script, and never needs to be pasted into a chat.
  - It checks the SHAPE of each value (a secret key starts sk_ / rk_, never pk_; a price id starts
    price_; a webhook signing secret starts whsec_) and refuses to continue on a mismatch.
  - Use the TEST-mode values first, then run it again with the LIVE values on go-live day
    (Stripe keeps test and live products, prices, portals and webhook endpoints entirely separate).
#>
param([string]$ProjectRef = 'rcdrgoxtawlemhzmpcry')

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $repo '.tools\supabase.exe'
if (-not (Test-Path $cli)) { $cli = 'supabase' }

function Ask([string]$label, [string[]]$prefixes) {
  $secure = Read-Host $label -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  $value = $value.Trim()
  if ($value -match '^pk_') { throw "That looks like a PUBLISHABLE key (pk_...). The functions need the SECRET key (sk_...)." }
  foreach ($p in $prefixes) { if ($value.StartsWith($p)) { return $value } }
  throw "Expected a value starting with $($prefixes -join ' or '). Nothing was saved."
}

$key   = Ask 'Stripe SECRET key (sk_test_... or sk_live_...)'      @('sk_test_', 'sk_live_', 'rk_test_', 'rk_live_')
$price = Ask 'Stripe PRICE id for the GBP 10/month plan (price_...)' @('price_')
$hook  = Ask 'Stripe webhook SIGNING secret (whsec_...)'            @('whsec_')

$mode = if ($key -match '_live_') { 'LIVE' } else { 'TEST' }
Write-Host "Saving $mode-mode Stripe secrets to project $ProjectRef ..."

$envFile = Join-Path ([IO.Path]::GetTempPath()) ("stripe-secrets-" + [guid]::NewGuid().ToString('N') + '.env')
try {
  Set-Content -Path $envFile -Value @("STRIPE_SECRET_KEY=$key", "STRIPE_PRICE_ID=$price", "STRIPE_WEBHOOK_SECRET=$hook") -Encoding ascii
  & $cli secrets set --env-file $envFile --project-ref $ProjectRef
  if ($LASTEXITCODE -ne 0) { throw "supabase secrets set failed (exit $LASTEXITCODE)" }
}
finally {
  if (Test-Path $envFile) { Remove-Item $envFile -Force }
  $key = $null; $price = $null; $hook = $null
}

Write-Host "Done. Check it took: python tools/go_live.py check"
Write-Host "(billing-webhook should now answer 400 and billing-checkout 401 instead of 503)"
