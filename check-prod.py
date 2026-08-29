#!/usr/bin/env python3
"""Fails if the build still contains dev-only placeholders. Run before deploying:
   python3 check-prod.py --prod
"""
import sys, pathlib, re
prod = '--prod' in sys.argv
issues = []

build = pathlib.Path('build.py').read_text()
base = re.search(r"BASE_URL\s*=\s*'([^']+)'", build).group(1)
api  = re.search(r"API_URL *= *'([^']+)'", build).group(1)

if prod:
    if 'example' in base:            issues.append(f"BASE_URL is still a placeholder: {base}")
    if 'localhost' in api:           issues.append(f"API_URL still points at localhost: {api}")
    env = pathlib.Path('server/.env')
    if env.exists():
        e = env.read_text()
        if 'EXPOSE_OTP=true' in e:    issues.append("EXPOSE_OTP=true — must be false in production")
        if re.search(r'JWT_SECRET=(change|dev|secret|test)', e, re.I):
            issues.append("JWT_SECRET looks weak — use `openssl rand -hex 32`")
        if 'localhost' in (re.search(r'CORS_ORIGIN=(.*)', e) or [''])[0] if re.search(r'CORS_ORIGIN=(.*)', e) else False:
            issues.append("CORS_ORIGIN still allows localhost")

# always-on checks
for pg in pathlib.Path('.').glob('*.html'):
    html = pg.read_text()
    if pg.name != 'admin.html' and '<title>' not in html:
        issues.append(f"{pg.name}: missing <title>")
    if pg.name not in ('admin.html','offline.html') and 'og:image' not in html:
        issues.append(f"{pg.name}: missing Open Graph image")

if issues:
    print("PRODUCTION CHECK FAILED:")
    for i in issues: print("  ✗", i)
    sys.exit(1)
print("Production check passed" + (" (prod mode)" if prod else " (dev checks only)"))
