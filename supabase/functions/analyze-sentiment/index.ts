/**
 * Supabase Edge Function: analyze-sentiment
 *
 * Analyzes the sentiment of a journal entry.
 * Called via supabase.functions.invoke('analyze-sentiment', { body: { entryId } }).
 *
 * This runs server-side with service_role, so it can read any entry
 * and write to the insights table regardless of RLS.
 *
 * Deploy: supabase functions deploy analyze-sentiment
 */

// @ts-nocheck — Deno runtime, not Node
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Simple rule-based sentiment analysis.
 * Replace with a proper NLP API (OpenAI, HuggingFace, etc.) in production.
 */
function analyzeSentiment(text: string): { score: number; label: string; confidence: number } {
  const positiveWords = [
    'happy', 'joy', 'love', 'great', 'wonderful', 'amazing', 'good', 'grateful',
    'blessed', 'excited', 'proud', 'peaceful', 'calm', 'beautiful', 'hope',
    'thankful', 'inspired', 'delighted', 'cheerful', 'content', 'optimistic',
  ];
  const negativeWords = [
    'sad', 'angry', 'hate', 'terrible', 'awful', 'bad', 'depressed', 'anxious',
    'worried', 'frustrated', 'disappointed', 'lonely', 'stressed', 'overwhelmed',
    'exhausted', 'miserable', 'hopeless', 'dread', 'fear', 'pain',
  ];

  const words = text.toLowerCase().split(/\W+/);
  let positiveCount = 0;
  let negativeCount = 0;

  for (const word of words) {
    if (positiveWords.includes(word)) positiveCount++;
    if (negativeWords.includes(word)) negativeCount++;
  }

  const total = positiveCount + negativeCount;
  if (total === 0) {
    return { score: 0, label: 'neutral', confidence: 0.5 };
  }

  const score = (positiveCount - negativeCount) / total;
  const label = score > 0.2 ? 'positive' : score < -0.2 ? 'negative' : 'neutral';
  const confidence = Math.min(0.9, 0.3 + total * 0.05);

  return { score: Math.round(score * 100) / 100, label, confidence };
}

serve(async (req) => {
  // Handle CORS preflight.
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Verify the caller is authenticated.
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing auth header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', ''),
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { entryId } = await req.json();
    if (!entryId) {
      return new Response(JSON.stringify({ error: 'entryId is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch the entry (service_role bypasses RLS, but we verify ownership).
    const { data: entry, error: entryError } = await supabase
      .from('entries')
      .select('*')
      .eq('id', entryId)
      .eq('user_id', user.id)
      .single();

    if (entryError || !entry) {
      return new Response(JSON.stringify({ error: 'Entry not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Analyze.
    const result = analyzeSentiment(entry.content);

    // Store the result.
    await supabase.from('insights').insert({
      user_id: user.id,
      entry_id: entryId,
      type: 'sentiment',
      payload: result,
    });

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
