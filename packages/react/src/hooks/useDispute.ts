import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useILNClient } from '../context';
import type {
  DisputeRecord,
  DisputeStatus,
  DisputeAnalytics,
  DisputeReasonCategory,
  DisputeResolutionDecision,
} from '@iln/shared';

/** @public Stable cache-key factory for consumers that invalidate dispute queries directly. */
export const disputeKeys = {
  all: ['disputes'] as const,
  dispute: (id: bigint | string) => ['disputes', 'detail', String(id)] as const,
  disputes: (status?: string) => ['disputes', 'list', status ?? 'all'] as const,
  analytics: () => ['disputes', 'analytics'] as const,
};

export interface UseDisputeResult {
  data: DisputeRecord | null | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

export function useDispute(invoiceId: bigint | string | undefined): UseDisputeResult {
  const client = useILNClient();
  const idStr = invoiceId !== undefined ? String(invoiceId) : undefined;

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: disputeKeys.dispute(idStr ?? '0'),
    queryFn: async () => {
      if (!idStr) return null;
      if ('getDispute' in client && typeof (client as any).getDispute === 'function') {
        return (client as any).getDispute(BigInt(idStr));
      }
      return null;
    },
    enabled: idStr !== undefined && idStr !== '0',
    staleTime: 10_000,
  });

  return {
    data,
    isLoading,
    error: error instanceof Error ? error : null,
    refetch,
  };
}

export interface UseDisputeListResult {
  data: DisputeRecord[] | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

export function useDisputeList(statusFilter?: DisputeStatus | string): UseDisputeListResult {
  const client = useILNClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: disputeKeys.disputes(statusFilter),
    queryFn: async () => {
      if ('listDisputes' in client && typeof (client as any).listDisputes === 'function') {
        return (client as any).listDisputes(statusFilter ? { status: statusFilter } : undefined);
      }
      return [];
    },
    staleTime: 10_000,
  });

  return {
    data,
    isLoading,
    error: error instanceof Error ? error : null,
    refetch,
  };
}

export interface FileDisputeParams {
  disputer?: string;
  invoiceId: bigint | number | string;
  reasonCategory: DisputeReasonCategory | string;
  evidenceCid: string;
  reasonDescription?: string;
}

export interface UseFileDisputeResult {
  fileDispute: (params: FileDisputeParams) => Promise<unknown>;
  isPending: boolean;
  error: Error | null;
}

export function useFileDispute(): UseFileDisputeResult {
  const client = useILNClient();
  const queryClient = useQueryClient();

  const { mutateAsync, isPending, error } = useMutation({
    mutationFn: async (params: FileDisputeParams) => {
      if ('disputeInvoice' in client && typeof (client as any).disputeInvoice === 'function') {
        return (client as any).disputeInvoice(params);
      }
      throw new Error('disputeInvoice not supported by client');
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: disputeKeys.all });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoice', String(variables.invoiceId)] });
    },
  });

  return {
    fileDispute: mutateAsync,
    isPending,
    error: error instanceof Error ? error : null,
  };
}

export interface SubmitDisputeEvidenceParams {
  submitter?: string;
  invoiceId: bigint | number | string;
  evidenceCid: string;
  description?: string;
}

export interface UseSubmitDisputeEvidenceResult {
  submitEvidence: (params: SubmitDisputeEvidenceParams) => Promise<unknown>;
  isPending: boolean;
  error: Error | null;
}

export function useSubmitDisputeEvidence(): UseSubmitDisputeEvidenceResult {
  const client = useILNClient();
  const queryClient = useQueryClient();

  const { mutateAsync, isPending, error } = useMutation({
    mutationFn: async (params: SubmitDisputeEvidenceParams) => {
      if (
        'submitDisputeEvidence' in client &&
        typeof (client as any).submitDisputeEvidence === 'function'
      ) {
        return (client as any).submitDisputeEvidence(params);
      }
      throw new Error('submitDisputeEvidence not supported by client');
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: disputeKeys.dispute(variables.invoiceId),
      });
      queryClient.invalidateQueries({ queryKey: disputeKeys.all });
    },
  });

  return {
    submitEvidence: mutateAsync,
    isPending,
    error: error instanceof Error ? error : null,
  };
}

export interface ResolveDisputeParams {
  admin?: string;
  invoiceId: bigint | number | string;
  decision: DisputeResolutionDecision | 'favor_payer' | 'favor_freelancer';
  notes?: string;
}

export interface UseResolveDisputeResult {
  resolveDispute: (params: ResolveDisputeParams) => Promise<unknown>;
  isPending: boolean;
  error: Error | null;
}

export function useResolveDispute(): UseResolveDisputeResult {
  const client = useILNClient();
  const queryClient = useQueryClient();

  const { mutateAsync, isPending, error } = useMutation({
    mutationFn: async (params: ResolveDisputeParams) => {
      if ('resolveDispute' in client && typeof (client as any).resolveDispute === 'function') {
        return (client as any).resolveDispute(params);
      }
      throw new Error('resolveDispute not supported by client');
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: disputeKeys.all });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoice', String(variables.invoiceId)] });
    },
  });

  return {
    resolveDispute: mutateAsync,
    isPending,
    error: error instanceof Error ? error : null,
  };
}

export interface AutoResolveDisputeParams {
  caller?: string;
  invoiceId: bigint | number | string;
}

export interface UseAutoResolveDisputeResult {
  autoResolveDispute: (params: AutoResolveDisputeParams) => Promise<unknown>;
  isPending: boolean;
  error: Error | null;
}

export function useAutoResolveDispute(): UseAutoResolveDisputeResult {
  const client = useILNClient();
  const queryClient = useQueryClient();

  const { mutateAsync, isPending, error } = useMutation({
    mutationFn: async (params: AutoResolveDisputeParams) => {
      if (
        'autoResolveDispute' in client &&
        typeof (client as any).autoResolveDispute === 'function'
      ) {
        return (client as any).autoResolveDispute(params);
      }
      throw new Error('autoResolveDispute not supported by client');
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: disputeKeys.all });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoice', String(variables.invoiceId)] });
    },
  });

  return {
    autoResolveDispute: mutateAsync,
    isPending,
    error: error instanceof Error ? error : null,
  };
}

export interface UseDisputeAnalyticsResult {
  data: DisputeAnalytics | undefined;
  isLoading: boolean;
  error: Error | null;
}

export function useDisputeAnalytics(): UseDisputeAnalyticsResult {
  const client = useILNClient();

  const { data, isLoading, error } = useQuery({
    queryKey: disputeKeys.analytics(),
    queryFn: async () => {
      if (
        'getDisputeAnalytics' in client &&
        typeof (client as any).getDisputeAnalytics === 'function'
      ) {
        return (client as any).getDisputeAnalytics();
      }
      return {
        totalDisputes: 0,
        disputeRateByPayer: {},
        averageResolutionTimeSeconds: 0,
        winRateByParty: { payer: 0, freelancer: 0 },
        commonDisputeReasons: { quality: 0, timing: 0, amount: 0, other: 0 },
      };
    },
    staleTime: 30_000,
  });

  return {
    data,
    isLoading,
    error: error instanceof Error ? error : null,
  };
}
