# Gather 0.4.1

The desktop app now has the Gather logo everywhere: the Windows executable, installer, shortcuts and tray, plus the browser tab icon and link previews.

Closing the window keeps Gather running in the tray so calls and notifications keep working (Quit from the tray menu really quits). There is an option to start Gather when you sign in. The taskbar and tray show an unread count, and unread chats show a count badge.

Chat: @mentions with autocomplete that still notify you in muted chats, Away (after five idle minutes) and a short status line, "Seen by" markers, mute for an hour, eight hours, until tomorrow or until you turn it off, Do Not Disturb, and keyboard shortcuts (Ctrl/Cmd+K, Alt+Up/Down, Ctrl/Cmd+/, Up to edit your last message).

Account: you can now delete your own account from Settings. This removes your messages and files, removes you from your chats and signs you out everywhere.

Mac and Linux builds are available from the download page as previews with no auto-update. Windows installs update automatically with a signed update.

Verification: unit and server tests, the full packaged and browser release check, and pre- and post-deploy backups with restore tests. Production reports schema 12 with the `presence-status-v1` and `account-delete-v1` capabilities. Not verified: the installed shortcut and tray on a real desktop, real 0.4.0 to 0.4.1 auto-update, and downloads on a Mac or Linux machine.
