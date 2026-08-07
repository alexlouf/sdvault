# SD-Vault v2 - Launch Script
# Configures the portable compiler paths and starts the Tauri dev server.

$devkitBin = Join-Path $env:TEMP "w64devkit_extracted\w64devkit\bin"
if (Test-Path $devkitBin) {
    Write-Host "[SD-Vault] Configuring portable GCC compiler path..." -ForegroundColor Cyan
    $env:PATH = "$devkitBin;" + $env:PATH
} else {
    Write-Host "[SD-Vault] Warning: Portable compiler w64devkit not found at $devkitBin." -ForegroundColor Yellow
}

$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (Test-Path $cargoBin) {
    Write-Host "[SD-Vault] Configuring Rust Cargo path..." -ForegroundColor Cyan
    $env:PATH = "$cargoBin;" + $env:PATH
}

$selfContainedLib = Join-Path $env:USERPROFILE ".rustup\toolchains\stable-x86_64-pc-windows-gnu\lib\rustlib\x86_64-pc-windows-gnu\lib\self-contained"
if (Test-Path $selfContainedLib) {
    Write-Host "[SD-Vault] Configuring Rust self-contained library search paths..." -ForegroundColor Cyan
    $env:RUSTFLAGS = "-L $selfContainedLib"
}

Write-Host "[SD-Vault] Launching Tauri Dev Server..." -ForegroundColor Green
npm run tauri dev
