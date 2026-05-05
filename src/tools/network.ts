/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './ToolDefinition.js';
import {writeFile} from 'node:fs/promises';

// Resource types as string literals (Playwright returns string from resourceType())
const FILTERABLE_RESOURCE_TYPES = [
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'texttrack',
  'xhr',
  'fetch',
  'prefetch',
  'eventsource',
  'websocket',
  'manifest',
  'signedexchange',
  'ping',
  'cspviolationreport',
  'preflight',
  'other',
] as const;

export const listNetworkRequests = defineTool({
  name: 'list_network_requests',
  description: `List network requests for the currently selected page since the last navigation. Results are sorted newest-first. By default returns the 20 most recent requests; use pageSize/pageIdx to paginate. Pass reqid to get a single request's full details.`,
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: true,
  },
  schema: {
    reqid: zod
      .number()
      .optional()
      .describe(
        'The reqid of a specific network request to get full details for. If omitted, lists all requests.',
      ),
    pageSize: zod
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Maximum number of requests to return. Defaults to 20.',
      ),
    pageIdx: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Page number to return (0-based). When omitted, returns the first page.',
      ),
    resourceTypes: zod
      .array(zod.enum(FILTERABLE_RESOURCE_TYPES))
      .optional()
      .describe(
        'Filter requests to only return requests of the specified resource types. When omitted or empty, returns all requests.',
      ),
    urlFilter: zod
      .string()
      .optional()
      .describe(
        'Filter requests by URL. Only requests containing this substring will be returned.',
      ),
    includePreservedRequests: zod
      .boolean()
      .default(false)
      .optional()
      .describe(
        'Set to true to return the preserved requests over the last 3 navigations.',
      ),
  },
  handler: async (request, response, context) => {
    if (request.params.reqid !== undefined) {
      response.attachNetworkRequest(request.params.reqid);
      return;
    }
    const data = await context.getDevToolsData();
    const reqid = data?.cdpRequestId
      ? context.resolveCdpRequestId(data.cdpRequestId)
      : undefined;
    response.setIncludeNetworkRequests(true, {
      pageSize: request.params.pageSize,
      pageIdx: request.params.pageIdx,
      resourceTypes: request.params.resourceTypes,
      urlFilter: request.params.urlFilter,
      includePreservedRequests: request.params.includePreservedRequests,
      networkRequestIdInDevToolsUI: reqid,
    });
  },
});

// network_get_body returns the raw bytes of a captured request OR response,
// base64-encoded so binary payloads (protobuf, encrypted blobs, images)
// transit cleanly. list_network_requests' inline body view truncates and
// drops anything that isn't valid UTF-8 -- needed when the workflow is
// "capture request, decrypt offline" rather than "preview as text".
//
// Pass which=request|response to pick which side of the exchange. For very
// large bodies, pass outputFile to dump straight to disk instead of inlining.
export const getNetworkBody = defineTool({
  name: 'network_get_body',
  description: `Return the raw bytes of a captured request or response body, base64-encoded. Use this when list_network_requests shows "<binary data>" or truncates a large body — typical for protobuf, gzipped JSON, encrypted blobs, etc. Pass outputFile to write straight to disk; otherwise the base64 is returned inline (~4 KB cap).`,
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: true,
  },
  schema: {
    reqid: zod
      .number()
      .describe('reqid from list_network_requests.'),
    which: zod
      .enum(['request', 'response'])
      .default('response')
      .describe('Which side of the exchange to read. Default: response.'),
    outputFile: zod
      .string()
      .optional()
      .describe(
        'If set, writes raw bytes to this absolute path instead of returning base64 inline. Useful for bodies > a few KB.',
      ),
    inlineByteLimit: zod
      .number()
      .int()
      .positive()
      .optional()
      .default(4096)
      .describe(
        'Maximum bytes to return inline (default 4096). Bodies larger than this require outputFile.',
      ),
  },
  handler: async (request, response, context) => {
    const {reqid, which, outputFile, inlineByteLimit} = request.params;
    const httpRequest = context.getNetworkRequestById(reqid);
    if (!httpRequest) {
      response.appendResponseLine(`No request with reqid=${reqid}`);
      return;
    }

    let buf: Uint8Array | null = null;
    if (which === 'request') {
      const data = httpRequest.postData();
      if (data) buf = Buffer.from(data, 'utf8');
      // postData() returns a string; for true binary request bodies (protobuf
      // POSTs etc) Playwright surfaces the bytes via postDataBuffer().
      const reqAny = httpRequest as unknown as {
        postDataBuffer?: () => Uint8Array | null;
      };
      if (typeof reqAny.postDataBuffer === 'function') {
        const raw = reqAny.postDataBuffer();
        if (raw) buf = raw;
      }
    } else {
      const httpResponse = await httpRequest.response();
      if (!httpResponse) {
        response.appendResponseLine(`Request ${reqid} has no response yet (pending or failed).`);
        return;
      }
      try {
        buf = await httpResponse.body();
      } catch (e) {
        response.appendResponseLine(`Could not read body: ${(e as Error).message}`);
        return;
      }
    }

    if (!buf || buf.length === 0) {
      response.appendResponseLine(`<empty ${which} body>`);
      return;
    }

    if (outputFile) {
      await writeFile(outputFile, buf);
      response.appendResponseLine(
        `wrote ${buf.length} bytes to ${outputFile} (${which} body of reqid=${reqid})`,
      );
      return;
    }

    if (buf.length > inlineByteLimit) {
      response.appendResponseLine(
        `body is ${buf.length} bytes (> inlineByteLimit=${inlineByteLimit}); pass outputFile=/abs/path to dump.`,
      );
      return;
    }

    response.appendResponseLine(`reqid=${reqid} ${which} body: ${buf.length} bytes (base64)`);
    response.appendResponseLine(Buffer.from(buf).toString('base64'));
  },
});

// cdp_send is an escape hatch for raw Chrome DevTools Protocol commands the
// MCP doesn't expose as named tools. Useful for things like
// Debugger.setBreakpointByUrl with a regex, Runtime.queryObjects, or
// DOMDebugger.setEventListenerBreakpoint -- all primitives that come up
// during reverse engineering but would bloat the tool list as separate
// commands.
export const cdpSend = defineTool({
  name: 'cdp_send',
  description: `Escape hatch: send a raw Chrome DevTools Protocol command on the selected page's CDP session. Use for primitives the MCP doesn't expose as named tools (Debugger.setBreakpointByUrl with regex, Runtime.queryObjects, DOMDebugger.setEventListenerBreakpoint, etc). Returns the JSON result.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    method: zod
      .string()
      .describe('CDP method like "Network.getResponseBody" or "Runtime.queryObjects".'),
    params: zod
      .record(zod.unknown())
      .optional()
      .describe('Method parameters as a JSON object. Empty object if omitted.'),
  },
  handler: async (request, response, context) => {
    const {method, params} = request.params;
    const page = context.getSelectedPage();
    // Patchright's CDPSession is reachable via context.newCDPSession(page).
    const session = await page.context().newCDPSession(page);
    try {
      const result = await session.send(method as never, (params ?? {}) as never);
      response.appendResponseLine(`CDP ${method} ->`);
      response.appendResponseLine(JSON.stringify(result, null, 2));
    } catch (e) {
      response.appendResponseLine(`CDP ${method} FAILED: ${(e as Error).message}`);
    } finally {
      try { await session.detach(); } catch { /* best-effort cleanup */ }
    }
  },
});
