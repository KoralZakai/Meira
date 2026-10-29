/**
 * MeiraAskHost — where Meira's questions appear, over any screen.
 *
 * Mounted once at the root (App.tsx), so a question can follow her save on the
 * Profile screen as easily as it pops up on Today. It only listens:
 * QuestionService decides WHEN (utils/questionQueue) and applies the answer.
 */
import React, { useEffect, useState } from 'react';
import MeiraAskSheet from './MeiraAskSheet';
import { useAppLanguage } from '../hooks/useAppLanguage';
import * as Questions from '../services/QuestionService';
import type { MeiraQuestion } from '../questions/types';

export default function MeiraAskHost() {
  const { he } = useAppLanguage();
  const [question, setQuestion] = useState<MeiraQuestion | null>(null);

  useEffect(() => Questions.onAsk((q) => {
    Questions.setSheetOpen(true);
    setQuestion(q);
  }), []);

  const close = () => {
    Questions.setSheetOpen(false);
    setQuestion(null);
  };

  return (
    <MeiraAskSheet
      question={question}
      he={he}
      onAnswer={(a) => Questions.answer(question!, a)}
      onLater={async () => {
        if (question) await Questions.snooze(question);
        close();
      }}
      onClose={close}
      onRetry={Questions.retryOutbox}
      onConfirmRule={Questions.confirmRule}
    />
  );
}
