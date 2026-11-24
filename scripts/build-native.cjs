const {execFileSync}=require('node:child_process');const path=require('node:path');
if(process.platform==='darwin')execFileSync('/usr/bin/xcrun',['swiftc','-O',path.join(__dirname,'../native/LocalExtract.swift'),'-o',path.join(__dirname,'../native/worktool-extract')],{stdio:'inherit'});

if(process.platform==='darwin')execFileSync('/usr/bin/xcrun',['swiftc','-O',path.join(__dirname,'../native/ConnectSavedDesktop.swift'),'-o',path.join(__dirname,'../native/worktool-connect')],{stdio:'inherit'});
