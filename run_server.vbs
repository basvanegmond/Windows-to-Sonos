Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\basva\OneDrive\Desktop\Tools\Windows-to-Sonos"
WshShell.Run """C:\Users\basva\OneDrive\Desktop\Tools\Windows-to-Sonos\.venv\Scripts\python.exe"" app.py", 0, False
