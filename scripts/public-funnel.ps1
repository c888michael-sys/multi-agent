param(
  [Parameter(Position = 0)]
  [ValidateSet('Start', 'Pause', 'Status')]
  [string]$Action = 'Status',
  [string]$OwnerUrl = 'http://127.0.0.1:7421',
  [int]$PublicPort = 7422
)

$ErrorActionPreference = 'Stop'

function Get-OwnerSecurityContext {
  Invoke-RestMethod -Method Get -Uri "$OwnerUrl/api/security/context"
}

if ($Action -eq 'Status') {
  $appStatus = Invoke-RestMethod -Method Get -Uri "$OwnerUrl/api/public/status"
  $appState = if ($appStatus.paused) { 'paused' } else { 'active' }
  Write-Host "App public access: $appState"
  Write-Host "Browser sessions: $($appStatus.sessions); unused invites: $($appStatus.pendingInvites)"
  & tailscale funnel status
  exit $LASTEXITCODE
}

$security = Get-OwnerSecurityContext
$headers = @{ 'X-CSRF-Token' = $security.csrfToken }

if ($Action -eq 'Pause') {
  Invoke-RestMethod -Method Post -Uri "$OwnerUrl/api/public/pause" -Headers $headers -ContentType 'application/json' -Body '{}' | Out-Null
  Write-Host 'Application access paused; invites and browser sessions revoked.'
  & tailscale funnel reset
  if ($LASTEXITCODE -ne 0) { throw "Tailscale Funnel reset failed with exit code $LASTEXITCODE" }
  Write-Host 'Tailscale Funnel route removed.'
  exit 0
}

$invite = Invoke-RestMethod -Method Post -Uri "$OwnerUrl/api/public/invite" -Headers $headers -ContentType 'application/json' -Body '{}'
& tailscale funnel --bg $PublicPort
if ($LASTEXITCODE -ne 0) {
  Invoke-RestMethod -Method Post -Uri "$OwnerUrl/api/public/pause" -Headers $headers -ContentType 'application/json' -Body '{}' | Out-Null
  throw "Tailscale Funnel failed with exit code $LASTEXITCODE; the invite was revoked"
}
Write-Host 'Public Funnel enabled.'
Write-Host "ONE-TIME LINK: $($invite.url)"
Write-Host "Invite expires: $($invite.expiresAt)"
