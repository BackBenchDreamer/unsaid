/**
 * Journal Page — the main writing view.
 *
 * Reads the date from the route param or defaults to today.
 */

import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { JournalEditor } from './JournalEditor';
import { getTodayLocal } from '../../shared/utils/dates';
import { isValidEntryDate } from '../../entities/entry';

export default function JournalPage() {
  const { date } = useParams<{ date?: string }>();
  const navigate = useNavigate();

  const entryDate = date && isValidEntryDate(date) ? date : getTodayLocal();

  // If the URL had an invalid date, redirect to today.
  React.useEffect(() => {
    if (date && !isValidEntryDate(date)) {
      navigate('/journal', { replace: true });
    }
  }, [date, navigate]);

  return (
    <div className="page journal-page">
      <JournalEditor date={entryDate} />
    </div>
  );
}
