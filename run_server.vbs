' Launches the server with no console window. Paths are derived from this
' script's own location, never hardcoded: the project folder has moved before
' (OneDrive Desktop), which left the launcher and the Scheduled Task pointing
' at a directory that no longer existed.
Set fso = CreateObject("Scripting.FileSystemObject")
projectDir = fso.GetParentFolderName(WScript.ScriptFullName)

python = projectDir & "\.venv\Scripts\pythonw.exe"
If Not fso.FileExists(python) Then python = projectDir & "\.venv\Scripts\python.exe"

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = projectDir
shell.Run """" & python & """ app.py", 0, False
