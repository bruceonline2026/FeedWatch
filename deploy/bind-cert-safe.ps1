# ============================================================
# bind-cert-safe.ps1 — 加固版证书绑定（2026-10-13）
#
# 与原 bind-cert.ps1 的差异（每一条都是实测发现的问题）：
#
# 1. 移除 `netsh http delete sslcert ipport=0.0.0.0:443`
#    原脚本会删除 HTTP.sys 全局 443 映射。本机有 6 个站点共用 443
#    （www / game / demo / test / nedevai / truckmission），
#    删全局条目在多站点 SNI 场景下不必要且有破坏性。
#    如需 netsh 仅在「单IP:443 无 SNI」场景有意义，本机不属于该场景。
#
# 2. 支持「新建 443 绑定」
#    原脚本用 Where-Object 找现有 443 绑定，找不到就 throw。
#    但 api.tiici.com 所在的 API 站点根本没有 443 绑定 → 必然失败。
#    本脚本在不存在时自动创建 https *:443:<domain> 绑定。
#
# 3. 绑定前先移除同主机名+同协议的旧绑定
#    避免重复绑定导致 IIS 选错证书。
#
# 4. 绑定后不重启站点（重启由调用方决定，避免中断现有服务）
#
# 用法:
#   powershell -File bind-cert-safe.ps1 -Thumbprint <指纹> -Domain <域名> -SiteName <IIS站点名>
#
# 禁忌提醒：必须用 IISAdministration + CommitChanges，
#   禁止用 appcmd 经 SSH 加绑定（引号转义会污染协议名且静默失效）。
# ============================================================
param(
  [Parameter(Mandatory=$true)][string]$Thumbprint,
  [Parameter(Mandatory=$true)][string]$Domain,
  [Parameter(Mandatory=$true)][string]$SiteName,
  [switch]$RestartSite
)

$ErrorActionPreference = 'Stop'
$Thumbprint = $Thumbprint.ToUpper().Replace(' ','').Trim()

# 指纹格式校验（防止脏值静默失败）
if ($Thumbprint -notmatch '^[0-9A-F]{40}$') {
  throw "指纹格式非法: '$Thumbprint'（应为 40 位十六进制）"
}

Import-Module IISAdministration

# 1. 确认证书在库中且有私钥
$cert = Get-ChildItem "Cert:\LocalMachine\My" | Where-Object { $_.Thumbprint -eq $Thumbprint }
if (-not $cert) {
  throw "证书不在 LocalMachine\My 中: $Thumbprint"
}
if (-not $cert.HasPrivateKey) {
  throw "证书无私钥，拒绝绑定: $Thumbprint"
}
Write-Host "证书校验通过: CN=$($cert.Subject -replace '.*CN=','') 到期=$($cert.NotAfter.ToString('yyyy-MM-dd')) 剩余$([int]($cert.NotAfter - (Get-Date)).TotalDays)天"

# 2. thumbprint hex → byte[]
$bytes = New-Object byte[] ($Thumbprint.Length / 2)
for ($i = 0; $i -lt $bytes.Length; $i++) {
  $bytes[$i] = [Convert]::ToByte($Thumbprint.Substring($i*2, 2), 16)
}

$sm = Get-IISServerManager
if (-not $sm.Sites[$SiteName]) {
  throw "IIS 站点不存在: $SiteName"
}

$site = $sm.Sites[$SiteName]
Write-Host "目标站点: $SiteName  root=$($site.PhysicalPath)"

# 3. 移除同主机名的旧 https 绑定（避免重复/错选）
foreach ($b in @($site.Bindings)) {
  if ($b.Protocol -eq 'https' -and $b.BindingInformation -match [regex]::Escape($Domain)) {
    Write-Host "  移除旧 https 绑定: $($b.BindingInformation)"
    $b.RemoveBindings()
  }
}

# 4. 创建并设置证书
$newBinding = $site.Bindings.Add("*:443:$Domain", 'https')
$newBinding.CertificateHash = $bytes
$newBinding.CertificateStoreName = 'My'
$sm.CommitChanges()
Write-Host "  已创建 https *:443:$Domain 绑定并指定证书 $Thumbprint"

# 5. 核对（不靠假设，读回来确认）
$sm2 = Get-IISServerManager
$check = $sm2.Sites[$SiteName].Bindings | Where-Object { $_.Protocol -eq 'https' -and $_.BindingInformation -eq "*:443:$Domain" }
if (-not $check) {
  throw "绑定核对失败：提交后读不到 https *:443:$Domain"
}
$actualHash = ($check.CertificateHash | ForEach-Object { '{0:X2}' -f $_ }) -join ''
if ($actualHash -ne $Thumbprint) {
  throw "绑定核对失败：读回指纹 $actualHash != 期望 $Thumbprint"
}
Write-Host "  核对通过: https *:443:$Domain -> $actualHash"

# 6. 可选重启站点（HTTP.sys 有缓存，不重启可能仍用旧证书）
if ($RestartSite) {
  Write-Host "  重启站点 $SiteName ..."
  Restart-WebSite -Name $SiteName
  Write-Host "  已重启"
} else {
  Write-Host "  未重启站点（如外网未生效，在调用侧执行 Restart-WebSite -Name $SiteName）"
}

Write-Host "BIND_SUCCESS"
