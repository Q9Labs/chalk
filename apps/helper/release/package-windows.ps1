$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$version = (Get-Content src-tauri/tauri.conf.json -Raw | ConvertFrom-Json).version
$production = $env:GITHUB_EVENT_NAME -eq 'workflow_dispatch' -and $env:CHANNEL -eq 'production'
$identityPresent = -not [string]::IsNullOrWhiteSpace($env:STORE_IDENTITY)
$publisherPresent = -not [string]::IsNullOrWhiteSpace($env:STORE_PUBLISHER)
$displayNamePresent = -not [string]::IsNullOrWhiteSpace($env:STORE_PUBLISHER_DISPLAY_NAME)
$storeSubmission = $production -and $identityPresent -and $publisherPresent -and $displayNamePresent
if ($production -and (-not $storeSubmission) -and ($identityPresent -or $publisherPresent -or $displayNamePresent)) {
    throw 'Set all three Partner Center identity fields or leave them all unset.'
}

$identity = 'Q9Labs.ChalkHelper.Validation'
$publisher = 'CN=Chalk Helper CI'
$publisherDisplayName = 'Chalk Helper CI'
if ($storeSubmission) {
    $identity = $env:STORE_IDENTITY
    $publisher = $env:STORE_PUBLISHER
    $publisherDisplayName = $env:STORE_PUBLISHER_DISPLAY_NAME
}

$sdk = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Directory |
    Where-Object { Test-Path "$($_.FullName)\x64\makeappx.exe" } |
    Sort-Object { [version]$_.Name } -Descending |
    Select-Object -First 1
if (-not $sdk) { throw 'Windows SDK with MakeAppx was not found.' }
$makeappx = Join-Path $sdk.FullName 'x64\makeappx.exe'
$signtool = Join-Path $sdk.FullName 'x64\signtool.exe'

$work = Join-Path $env:RUNNER_TEMP 'helper-msix'
$package = Join-Path $work 'package'
$assets = Join-Path $package 'Assets'
New-Item -ItemType Directory -Path $assets -Force | Out-Null
Copy-Item src-tauri/target/release/chalk-helper.exe $package

Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Image]::FromFile((Resolve-Path src-tauri/icons/icon.png).Path)
try {
    foreach ($size in 44, 50, 150) {
        $logo = [System.Drawing.Bitmap]::new($icon, $size, $size)
        try {
            $logo.Save((Join-Path $assets "Logo$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $logo.Dispose()
        }
    }
} finally {
    $icon.Dispose()
}

[xml]$manifest = @'
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
         xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
         xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
         xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
         IgnorableNamespaces="uap uap10 rescap">
  <Identity Name="placeholder" Publisher="CN=placeholder" Version="0.0.0.0" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>Chalk Helper</DisplayName>
    <PublisherDisplayName>placeholder</PublisherDisplayName>
    <Logo>Assets\Logo50.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Applications>
    <Application Id="Helper" Executable="chalk-helper.exe" EntryPoint="Windows.FullTrustApplication"
                 uap10:RuntimeBehavior="packagedClassicApp" uap10:TrustLevel="mediumIL">
      <uap:VisualElements DisplayName="Chalk Helper" Description="See annotations while sharing your screen in Chalk."
                          Square150x150Logo="Assets\Logo150.png" Square44x44Logo="Assets\Logo44.png"
                          BackgroundColor="transparent" />
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
'@
$manifest.Package.Identity.SetAttribute("Name", $identity)
$manifest.Package.Identity.SetAttribute("Publisher", $publisher)
$manifest.Package.Identity.SetAttribute("Version", "$version.0")
$manifest.Package.Properties.PublisherDisplayName = $publisherDisplayName
$manifest.Save((Join-Path $package 'AppxManifest.xml'))

$submission = Join-Path $work 'Chalk-Helper-x64.msix'
& $makeappx pack /o /d $package /p $submission

# Only the test copy gets the ephemeral certificate. The Store signs the submission.
$testPackage = Join-Path $work 'Chalk-Helper-test.msix'
Copy-Item $submission $testPackage
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $publisher -CertStoreLocation 'Cert:\CurrentUser\My' -NotAfter (Get-Date).AddDays(1)
$activatedId = $null
try {
    $publicCertificate = Join-Path $work 'test.cer'
    Export-Certificate -Cert $cert -FilePath $publicCertificate | Out-Null
    Import-Certificate -FilePath $publicCertificate -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null
    & $signtool sign /fd SHA256 /sha1 $cert.Thumbprint $testPackage

    Add-AppxPackage -Path $testPackage
    $installed = Get-AppxPackage -Name $identity
    if (-not $installed -or $installed.Version.ToString() -ne "$version.0") {
        throw 'The MSIX did not register the expected identity and version.'
    }

    # Activate the package by application ID, not by launching the uninstalled build.
    Add-Type @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
class ApplicationActivationManager {}

[ComImport, Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationActivationManager {
    void ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string applicationId,
      [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint processId);
}

public static class HelperActivation {
    public static uint Activate(string applicationId) {
        var manager = (IApplicationActivationManager)new ApplicationActivationManager();
        manager.ActivateApplication(applicationId, "", 0, out uint processId);
        return processId;
    }
}
'@
    $activatedId = [HelperActivation]::Activate("$($installed.PackageFamilyName)!Helper")
    $url = 'http://127.0.0.1:47361/v1/challenge'
    $headers = @{ Origin = $env:CHALK_HELPER_WEB_ORIGIN }
    $body = @{ browserPublicKey = $env:CHALK_HELPER_PAIR_TICKET_PUBLIC_KEY } | ConvertTo-Json -Compress
    $deadline = (Get-Date).AddSeconds(45)
    $response = $null
    do {
        Get-Process -Id $activatedId | Out-Null
        try {
            $response = Invoke-RestMethod -Uri $url -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 2
        } catch [System.Net.Http.HttpRequestException] {
            if ((Get-Date) -ge $deadline) { throw }
            Start-Sleep -Seconds 1
        }
    } while ($null -eq $response)
    if (-not $response.helperPublicKey -or -not $response.challenge) {
        throw 'The installed Helper did not return a pairing challenge.'
    }

    'The Windows x64 MSIX installed, launched by package identity, and served a loopback pairing challenge.' >> $env:GITHUB_STEP_SUMMARY
    if ($storeSubmission) {
        'store_submission=true' >> $env:GITHUB_OUTPUT
    } else {
        'No Store submission artifact: the package uses a test identity or is not a production build.' >> $env:GITHUB_STEP_SUMMARY
    }
} finally {
    if ($activatedId) { Stop-Process -Id $activatedId -ErrorAction SilentlyContinue }
    Get-AppxPackage -Name $identity | Remove-AppxPackage -ErrorAction Continue
    Remove-Item "Cert:\LocalMachine\TrustedPeople\$($cert.Thumbprint)" -ErrorAction SilentlyContinue
    Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)" -ErrorAction SilentlyContinue
    Remove-Item $testPackage -ErrorAction SilentlyContinue
}
