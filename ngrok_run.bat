@echo off
REM — switch to the root of C:\
cd /d C:\

REM — start ngrok tunneling port 3000
REM   (if ngrok.exe lives in C:\, this will pick it up automatically)
ngrok http 3000

pause
