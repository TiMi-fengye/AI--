Set WSHShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
ROOT = FSO.GetParentFolderName(WScript.ScriptFullName)
WSHShell.CurrentDirectory = ROOT
WSHShell.Run "cmd /c node ""server\server.js""", 0, False