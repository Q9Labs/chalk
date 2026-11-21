param([switch]$Unprotected)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class ChalkMarker : Form
{
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity);

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams p = base.CreateParams;
            p.ExStyle |= 0x00000020 | 0x08000000 | 0x00080000; // transparent, no activate, layered
            return p;
        }
    }

    protected override bool ShowWithoutActivation { get { return true; } }
}
'@ -ReferencedAssemblies System.Windows.Forms
$form = New-Object ChalkMarker
$form.Text = "Chalk capture probe marker"
$form.FormBorderStyle = "None"
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.StartPosition = "Manual"
$form.Location = New-Object Drawing.Point(160, 190)
$form.Size = New-Object Drawing.Size(320, 200)
$form.BackColor = [Drawing.Color]::Magenta
$expected = if ($Unprotected) { 0 } else { 0x11 }
if (-not [ChalkMarker]::SetWindowDisplayAffinity($form.Handle, $expected)) {
    throw "SetWindowDisplayAffinity failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}
$actual = [uint32]0
if (-not [ChalkMarker]::GetWindowDisplayAffinity($form.Handle, [ref]$actual) -or $actual -ne $expected) {
    throw "Display affinity did not match the requested value."
}
Write-Output "Marker display affinity: $actual"
[Windows.Forms.Application]::Run($form)
