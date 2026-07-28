# Publishing preflight

## npm (2FA required)

Account `khosla` has **auth-and-writes** 2FA. Every publish needs a one-time password.

```bash
cd ~/preflight
npm whoami                    # khosla
npm run build
npm test
npm publish --access public --otp=123456   # real 6-digit code
npm view @khosla/preflight version
```

### Optional: automation token (no interactive OTP)

1. npmjs.com → Access Tokens → **Granular Access Token**
2. Permission: **Read and write** for `@khosla/preflight`
3. Enable **Bypass 2FA / automation** if offered
4. Store as `NPM_TOKEN` in CI secrets (never commit)

```bash
export NODE_AUTH_TOKEN=$NPM_TOKEN
npm publish --access public
```

GitHub Actions can use `NODE_AUTH_TOKEN` with `actions/setup-node` registry-url.

## GitHub release

```bash
npm version patch   # or minor/major — bumps package.json
git push origin main --tags
gh release create vX.Y.Z --generate-notes
```

Keep `src/version.ts` in sync with `package.json` version.

## Install matrix (document for users)

| Method | Command |
|---|---|
| npm global | `npm install -g @khosla/preflight` |
| bun global | `bun install -g @khosla/preflight` |
| npx | `npx @khosla/preflight doctor` |
| GitHub | `bun install -g github:gvkhosla/preflight` |

CLI binary name is always **`preflight`**.
