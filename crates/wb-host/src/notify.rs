use anyhow::Result;

fn xml_escape(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '&' => "&amp;".into(),
            '<' => "&lt;".into(),
            '>' => "&gt;".into(),
            '"' => "&quot;".into(),
            '\'' => "&apos;".into(),
            c if c.is_control() => ' '.to_string(),
            c => c.to_string(),
        })
        .collect()
}

/// Best-effort desktop toast. No-op / soft-fail when the platform cannot show one.
pub fn show_system_notification(title: &str, body: &str) -> Result<()> {
    #[cfg(windows)]
    {
        use std::process::Command;
        let title = xml_escape(title);
        let body = xml_escape(body);
        // Keep script short: WinRT toast via PowerShell (no extra crates).
        let script = format!(
            r#"
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml(@"
<toast>
  <visual>
    <binding template='ToastGeneric'>
      <text>{title}</text>
      <text>{body}</text>
    </binding>
  </visual>
</toast>
"@)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('my-workbench').Show($toast)
"#
        );
        let status = Command::new("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-WindowStyle",
                "Hidden",
                "-Command",
                &script,
            ])
            .status();
        match status {
            Ok(s) if s.success() => Ok(()),
            Ok(s) => anyhow::bail!("toast 退出码 {}", s.code().unwrap_or(-1)),
            Err(e) => Err(e.into()),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (title, body);
        Ok(())
    }
}
