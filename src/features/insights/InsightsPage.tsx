/**
 * Insights Page — sentiment analysis and patterns.
 * Foundation for future AI features.
 */

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../app/providers/AuthProvider';
import { insightsService } from '../../services/insightsService';

export default function InsightsPage() {
  const { user } = useAuth();

  const { data: insights, isLoading } = useQuery({
    queryKey: ['insights', user?.id],
    queryFn: () => insightsService.getInsights(user!.id),
    enabled: !!user,
  });

  return (
    <div className="page insights-page">
      <h1>Insights</h1>
      <p className="page-subtitle">Patterns and reflections from your journal.</p>

      {isLoading ? (
        <div className="loading-spinner" />
      ) : !insights || insights.length === 0 ? (
        <div className="empty-state">
          <p className="empty-icon">🔮</p>
          <p className="empty-title">No insights yet</p>
          <p className="empty-subtitle">
            Keep journaling — insights will appear as we learn from your entries.
          </p>
        </div>
      ) : (
        <div className="insights-grid">
          {insights.map((insight) => (
            <div key={insight.id} className="insight-card">
              <span className="insight-type">{insight.type}</span>
              <pre className="insight-payload">
                {JSON.stringify(insight.payload, null, 2)}
              </pre>
              <span className="insight-date">
                {new Date(insight.createdAt).toLocaleDateString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
