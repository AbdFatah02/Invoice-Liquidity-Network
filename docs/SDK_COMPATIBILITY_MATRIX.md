# SDK API Compatibility Matrix

This matrix documents supported combinations of ILN SDK packages and their peer dependencies.

## Supported Configurations

### @iln/sdk (Stable)

| SDK Version | React | React Native | @tanstack/react-query | Node.js | Status |
|-------------|-------|--------------|----------------------|---------|--------|
| 0.1.0 | ^19.0.0 | >=0.72 | N/A | >=20 | ✅ Supported |
| 0.1.0 | ^18.0.0 | >=0.72 | N/A | >=20 | ⚠️  Not Tested |
| 0.1.0 | None | None | N/A | >=20 | ✅ Supported |

### @iln/sdk-next (Experimental)

| SDK Version | React | @tanstack/react-query | Node.js | Status |
|-------------|-------|----------------------|---------|--------|
| 0.1.0 | N/A | N/A | >=20 | ✅ Supported |

### @iln/react (React Hooks)

| Package Version | @iln/sdk | @tanstack/react-query | React | Status |
|----------------|----------|----------------------|-------|--------|
| 0.1.0 | ^0.1.0 | ^5.62.0 | ^19.0.0 | ✅ Supported |
| 0.1.0 | ^0.1.0 | ^5.62.0 | ^18.0.0 | ⚠️  Not Tested |

## Breaking Changes

### Version 0.1.0
- Initial release; `@iln/react` declares `@iln/sdk@^0.1.0` as a peer
- React 19 required for @iln/react
- Node.js 20+ required for all packages

## Migration Paths

### From @iln/sdk to @iln/sdk-next
See [SDK vs SDK-next Migration Guide](sdk-next-migration.md) for detailed migration instructions.

**Key Differences:**
- `@iln/sdk` uses `ILNSdk` class
- `@iln/sdk-next` uses `InvoiceClient` class
- Different API surfaces - not compatible

### From React 18 to React 19
If upgrading React from 18 to 19:
1. Update `react` and `react-dom` to `^19.0.0`
2. Update `@iln/react` to `0.1.0`
3. Verify `@tanstack/react-query` is `^5.62.0`

## CI Validation Commands

### Validate @iln/sdk
```bash
cd sdk
pnpm install
pnpm run type-check
pnpm run test
pnpm run build
```

### Validate @iln/sdk-next
```bash
cd packages/sdk
pnpm install
pnpm run type-check
pnpm run test
pnpm run build
```

### Validate @iln/react
```bash
cd packages/react
pnpm install
pnpm run type-check
pnpm run test
pnpm run build
```

### Full Monorepo Validation
```bash
pnpm install
pnpm run build
pnpm run test
pnpm run lint
```

## Troubleshooting

### Peer Dependency Conflicts

If you encounter peer dependency warnings:

1. **Check peer ranges**: `@iln/react` requires `@iln/sdk@^0.1.0` and `react@^19.0.0`
2. **Update package manager**: Use `pnpm` for better peer dependency resolution
3. **Clear cache**: `pnpm store prune && rm -rf node_modules`

### React Version Mismatch

If React hooks fail:
- Ensure `react` and `react-dom` versions match
- Verify `@iln/react` peer dependency is satisfied
- Check for duplicate React installations: `pnpm why react`

## Support Matrix Updates

This matrix is updated with each SDK release. Check the changelog for version-specific compatibility notes.

Last Updated: 2026-10-16
