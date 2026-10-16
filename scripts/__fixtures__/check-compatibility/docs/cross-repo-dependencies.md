# Cross-Repo Dependency Version Compatibility Matrix

## Overview

| Repository | Component | Version Source |
|---|---|---|
| [ILN-Smart-Contract](https://github.com/Invoice-Liquidity-Network/ILN-Smart-Contract) | Soroban contracts (Rust) | `backend/contracts/invoice_liquidity/Cargo.toml` |

---

## Compatibility Matrix

Each row represents a tested, compatible combination of component versions.

<!-- COMPATIBILITY_MATRIX_START -->
| Contract (`invoice_liquidity`) | SDK (`@iln/sdk`) | Frontend (`ILN-Frontend`) | Notes |
|---|---|---|---|
| `0.1.0` | `0.1.0` | `0.1.0` | Initial release — all components aligned |
| `0.1.1` | `0.1.0` | `0.1.0` | Contract patch, SDK and frontend unchanged |
| `0.2.0` | `0.2.0` | `0.1.0` | Contract + SDK bump; frontend unchanged |
<!-- COMPATIBILITY_MATRIX_END -->
