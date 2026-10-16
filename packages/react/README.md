# @iln/react

React hooks for Invoice Liquidity Network contract data fetching. Built on [TanStack Query](https://tanstack.com/query) for caching, background refetching, and optimistic updates.

## Installation

```bash
npm install @iln/react @tanstack/react-query @iln/sdk

Quick Start
Wrap your app with ILNProvider and use the hooks:
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ILNProvider, useInvoice, useLPPortfolio } from '@iln/react';
import { ILNClient, Networks } from '@iln/sdk';

const queryClient = new QueryClient();
const ilnClient = new ILNClient({
  network: Networks.TESTNET,
  contractId: 'CCPASLHKRFBMVV5PZG3LKDGKFEDXZMB5U7DK42CVLUVWCMUCSRPVBIMO',
  rpcUrl: 'https://soroban-testnet.stellar.org',
});

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ILNProvider client={ilnClient}>
        <Dashboard />
      </ILNProvider>
    </QueryClientProvider>
  );
}

function Dashboard() {
  const { data: invoice, isLoading, error } = useInvoice(42);
  const { data: portfolio } = useLPPortfolio('G...');

  if (isLoading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <div>
      <h1>Invoice #{invoice?.id}</h1>
      <p>Status: {invoice?.status}</p>
      <p>LP Yield: {portfolio?.totalYield}</p>
    </div>
  );
}


Hooks
| Hook                            | Description                                                                 |
| ------------------------------- | --------------------------------------------------------------------------- |
| `useInvoice(id)`                | Fetch a single invoice by ID                                                |
| `useInvoiceList(address, role)` | Fetch invoices filtered by address and role (`'issuer'`, `'lp'`, `'payer'`) |
| `useReputationScore(address)`   | Fetch on-chain reputation for an address                                    |
| `useLPPortfolio(address)`       | Fetch LP portfolio (investments, yields, positions)                         |
| `useContractStats()`            | Fetch global protocol statistics (TVL, volume, etc.)                        |
| `useGovernanceProposal(id)`     | Fetch a governance proposal by ID                                           |
| `useTokenBalances(address)`     | Fetch multi-token balances for an address                                   |
All hooks return { data, isLoading, error }.


Requirements
React 18+
@tanstack/react-query 5.x (peer dependency)
@iln/sdk (peer dependency)


License
MIT
