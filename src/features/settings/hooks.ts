/**
 * Settings hooks — React Query wrappers for the settings service.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsService } from '../../services/settingsService';
import { useAuth } from '../../app/providers/AuthProvider';

export const settingsKeys = {
  all: ['settings'] as const,
  user: (userId: string) => [...settingsKeys.all, userId] as const,
};

export function useSettings() {
  const { user } = useAuth();

  return useQuery({
    queryKey: settingsKeys.user(user?.id ?? ''),
    queryFn: () => settingsService.getSettings(user!.id),
    enabled: !!user,
  });
}

export function useUpdateTheme() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: (theme: 'dark' | 'light') => {
      if (!user) throw new Error('Not authenticated');
      return settingsService.updateTheme(user.id, theme);
    },
    onSuccess: (_data, theme) => {
      // Apply immediately to DOM
      document.documentElement.dataset.theme = theme;
      // Invalidate the cached settings
      queryClient.invalidateQueries({ queryKey: settingsKeys.user(user?.id ?? '') });
    },
  });
}

export function useSaveHFToken() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: (plainToken: string) => {
      if (!user) throw new Error('Not authenticated');
      return settingsService.saveHFToken(plainToken);
    },
    onSuccess: () => {
      // Invalidate so hasHFToken refreshes
      queryClient.invalidateQueries({ queryKey: settingsKeys.user(user?.id ?? '') });
    },
  });
}

export function useSaveGroqToken() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: (plainToken: string) => {
      if (!user) throw new Error('Not authenticated');
      return settingsService.saveGroqToken(plainToken);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: settingsKeys.user(user?.id ?? '') });
    },
  });
}

export function useUpdateGroqModel() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: (model: string) => {
      if (!user) throw new Error('Not authenticated');
      return settingsService.updateGroqModel(user.id, model);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: settingsKeys.user(user?.id ?? '') });
    },
  });
}
