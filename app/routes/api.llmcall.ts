import { type ActionFunctionArgs } from '@remix-run/cloudflare';
import { streamText } from '~/lib/.server/llm/stream-text';
import type { IProviderSetting, ProviderInfo } from '~/types/model';
import { generateText } from 'ai';
import { PROVIDER_LIST } from '~/utils/constants';
import { MAX_TOKENS } from '~/lib/.server/llm/constants';
import { LLMManager } from '~/lib/modules/llm/manager';
import type { ModelInfo } from '~/lib/modules/llm/types';
import { getApiKeysFromCookie, getProviderSettingsFromCookie } from '~/lib/api/cookies';
import { createScopedLogger } from '~/utils/logger';

export async function action(args: ActionFunctionArgs) {
  return llmCallAction(args);
}

async function getModelList(options: {
  apiKeys?: Record<string, string>;
  providerSettings?: Record<string, IProviderSetting>;
  serverEnv?: Record<string, string>;
}) {
  const llmManager = LLMManager.getInstance(import.meta.env);
  return llmManager.updateModelList(options);
}

const logger = createScopedLogger('api.llmcall');

async function llmCallAction({ context, request }: ActionFunctionArgs) {
  const { system, message, model, provider, streamOutput } = await request.json<{
    system: string;
    message: string;
    model: string;
    provider: ProviderInfo;
    streamOutput?: boolean;
  }>();

  const { name: providerName } = provider;

  if (!model || typeof model !== 'string') {
    throw new Response('Invalid or missing model', { status: 400 });
  }
  if (!providerName || typeof providerName !== 'string') {
    throw new Response('Invalid or missing provider', { status: 400 });
  }

  const cookieHeader = request.headers.get('Cookie');
  const apiKeys = getApiKeysFromCookie(cookieHeader);
  const providerSettings = getProviderSettingsFromCookie(cookieHeader);

  try {
    const models = await getModelList({ apiKeys, providerSettings, serverEnv: context.cloudflare?.env as any });
    const modelDetails = models.find((m: ModelInfo) => m.name === model);

    if (!modelDetails) {
      throw new Error('Model not found');
    }

    const dynamicMaxTokens = modelDetails.maxTokenAllowed ?? MAX_TOKENS;
    const providerInfo = PROVIDER_LIST.find((p) => p.name === provider.name);

    if (!providerInfo) {
      throw new Error('Provider not found');
    }

    logger.info(`Generating response Provider: ${provider.name}, Model: ${modelDetails.name}`);

    const result = await generateText({
      system,
      messages: [{ role: 'user', content: message }],
      model: providerInfo.getModelInstance({
        model: modelDetails.name,
        serverEnv: context.cloudflare?.env as any,
        apiKeys,
        providerSettings,
      }),
      maxTokens: dynamicMaxTokens,
      toolChoice: 'none',
    });

    logger.info(`Generated response`);
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    logger.error(error);
    return new Response(error instanceof Error && error.message.includes('API key') ? 'Invalid or missing API key' : 'Internal Server Error', {
      status: error instanceof Error && error.message.includes('API key') ? 401 : 500,
    });
  }
}
