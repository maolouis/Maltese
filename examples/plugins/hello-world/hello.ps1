Add-Type -AssemblyName PresentationFramework
[System.Windows.MessageBox]::Show(
  "Hello from a Maltese plugin!",
  "Maltese plugin",
  [System.Windows.MessageBoxButton]::OK,
  [System.Windows.MessageBoxImage]::Information
) | Out-Null