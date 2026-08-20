'use client';

import { useState, useTransition } from 'react';
import { LoaderCircle, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { explainMatch } from '@/lib/actions/review';

interface CandidateExplanationProps {
  matchId: number;
  initialExplanation: string | null;
  initialProvider: string | null;
}

export function CandidateExplanation({
  matchId,
  initialExplanation,
  initialProvider,
}: CandidateExplanationProps) {
  const [pending, startTransition] = useTransition();
  const [explanation, setExplanation] = useState(initialExplanation);
  const [provider, setProvider] = useState(initialProvider);
  const [error, setError] = useState<string | null>(null);

  const generate = () => {
    setError(null);
    startTransition(async () => {
      const result = await explainMatch({ matchId });
      if (result?.serverError) {
        setError(String(result.serverError));
        return;
      }
      if (result?.data) {
        setExplanation(result.data.text);
        setProvider(result.data.provider);
      }
    });
  };

  if (explanation) {
    return (
      <div className="mt-4 flex gap-2 rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2.5" aria-live="polite">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-[#3157d5]" />
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[#3157d5]">
            {provider === 'openai' ? 'AI explanation' : 'Match explanation'} · saved
          </p>
          <p className="mt-0.5 text-xs leading-5 text-slate-600">{explanation}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={generate}
        disabled={pending}
        className="h-8 border-indigo-200 bg-white px-2.5 text-xs text-[#3157d5] hover:bg-indigo-50 hover:text-[#294bc0]"
      >
        {pending ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
        {pending ? 'Explaining…' : 'Explain match'}
      </Button>
      <span className="text-[11px] text-slate-400">Generated only when requested</span>
      {error && <span role="alert" className="basis-full text-xs text-destructive">{error}</span>}
    </div>
  );
}
