Option Explicit
Dim shell, fso, root, args
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
shell.CurrentDirectory = root
args = ""
If WScript.Arguments.Count > 0 Then args = " --fresh"
shell.Run "node.exe """ & root & "\scripts\pcl-bridge.mjs""" & args, 0, False
