import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Shared state the mock reads from. Tests mutate these to simulate different
// Sheet contents (existing tabs, prefilled header rows, append responses).
const state = {
  existingTabs: [],
  existingHeader: [],           // if populated, values.get returns this
  appendResponseRange: 'CallbackQueue!A2:K2',
  calls: {
    get: [],
    batchUpdate: [],
    valuesGet: [],
    valuesUpdate: [],
    valuesAppend: [],
  },
};

function resetState() {
  state.existingTabs = [];
  state.existingHeader = [];
  state.appendResponseRange = 'CallbackQueue!A2:K2';
  for (const k of Object.keys(state.calls)) state.calls[k].length = 0;
}

vi.mock('googleapis', () => ({
  google: {
    auth: {
      GoogleAuth: class FakeGoogleAuth {
        constructor(config) { this.config = config; }
      },
    },
    sheets: () => ({
      spreadsheets: {
        get: async (args) => {
          state.calls.get.push(args);
          return {
            data: {
              sheets: state.existingTabs.map((title, i) => ({
                properties: { title, index: i, sheetId: 100 + i },
              })),
            },
          };
        },
        batchUpdate: async (args) => {
          state.calls.batchUpdate.push(args);
          const addSheetReq = args?.requestBody?.requests?.find(r => r.addSheet);
          if (addSheetReq) {
            const title = addSheetReq.addSheet.properties.title;
            state.existingTabs.push(title);
            return { data: { replies: [{ addSheet: { properties: { title, sheetId: 999 } } }] } };
          }
          return { data: { replies: [] } };
        },
        values: {
          get: async (args) => {
            state.calls.valuesGet.push(args);
            return { data: { values: state.existingHeader.length ? [state.existingHeader] : [] } };
          },
          update: async (args) => {
            state.calls.valuesUpdate.push(args);
            return { data: {} };
          },
          append: async (args) => {
            state.calls.valuesAppend.push(args);
            return { data: { updates: { updatedRange: state.appendResponseRange } } };
          },
        },
      },
    }),
  },
}));

describe('CallbackQueue notify helpers', () => {
  const originalEnv = process.env;

  async function loadFreshNotify() {
    vi.resetModules();
    resetState();
    return import('../src/lib/notify.js');
  }

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      GOOGLE_CHATLOG_SHEET_ID: 'sheet-xyz',
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'x@y.com', private_key: 'k' }),
      ENSURE_CALLBACK_QUEUE_ON_LOAD: 'false',
      NODE_ENV: 'test',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('maskCallerPhone', () => {
    it('masks to (XXX) XXX-last4 format', async () => {
      const { maskCallerPhone } = await loadFreshNotify();
      expect(maskCallerPhone('+19175551234')).toBe('(XXX) XXX-1234');
      expect(maskCallerPhone('9175551234')).toBe('(XXX) XXX-1234');
      expect(maskCallerPhone('+1 (917) 555-1234')).toBe('(XXX) XXX-1234');
    });

    it('returns N/A when input has fewer than 4 digits', async () => {
      const { maskCallerPhone } = await loadFreshNotify();
      expect(maskCallerPhone('')).toBe('N/A');
      expect(maskCallerPhone(null)).toBe('N/A');
      expect(maskCallerPhone('abc')).toBe('N/A');
      expect(maskCallerPhone('12')).toBe('N/A');
    });
  });

  describe('ensureCallbackQueueTab', () => {
    it('creates the CallbackQueue tab on first call', async () => {
      const { ensureCallbackQueueTab } = await loadFreshNotify();
      const result = await ensureCallbackQueueTab();
      expect(result.ok).toBe(true);
      expect(result.title).toBe('CallbackQueue');

      const addSheetCall = state.calls.batchUpdate.find(c =>
        c.requestBody?.requests?.some(r => r.addSheet?.properties?.title === 'CallbackQueue'),
      );
      expect(addSheetCall).toBeDefined();

      const headerWrite = state.calls.valuesUpdate.find(c => c.range === 'CallbackQueue!A1:K1');
      expect(headerWrite).toBeDefined();
      expect(headerWrite.requestBody.values[0]).toEqual([
        'timestamp_iso',
        'timestamp_local',
        'caller_phone',
        'caller_phone_masked',
        'location_called',
        'original_autotext_sid',
        'callback_requested_via',
        'status',
        'closed_at',
        'closed_by',
        'closure_notes',
      ]);

      const layoutCalls = state.calls.batchUpdate.filter(c =>
        !c.requestBody?.requests?.some(r => r.addSheet),
      );
      const allRequests = layoutCalls.flatMap(c => c.requestBody.requests);
      expect(allRequests.some(r => r.updateSheetProperties?.properties?.gridProperties?.frozenRowCount === 1)).toBe(true);
      const dropdown = allRequests.find(r => r.setDataValidation);
      expect(dropdown).toBeDefined();
      expect(dropdown.setDataValidation.rule.condition.values.map(v => v.userEnteredValue))
        .toEqual(['pending', 'called_back', 'resolved', 'stale']);
    });

    it('is a no-op (no addSheet, no header rewrite) when tab + header already exist', async () => {
      const { ensureCallbackQueueTab } = await loadFreshNotify();

      // Seed: tab already exists AND header row matches the canonical schema.
      state.existingTabs = ['CallbackQueue'];
      state.existingHeader = [
        'timestamp_iso', 'timestamp_local', 'caller_phone', 'caller_phone_masked',
        'location_called', 'original_autotext_sid', 'callback_requested_via',
        'status', 'closed_at', 'closed_by', 'closure_notes',
      ];

      const result = await ensureCallbackQueueTab();
      expect(result.ok).toBe(true);

      const addSheetCount = state.calls.batchUpdate.filter(c =>
        c.requestBody?.requests?.some(r => r.addSheet),
      ).length;
      expect(addSheetCount).toBe(0);

      expect(state.calls.valuesUpdate.length).toBe(0);
    });

    it('returns {ok:false} when GOOGLE_CHATLOG_SHEET_ID is not configured', async () => {
      delete process.env.GOOGLE_CHATLOG_SHEET_ID;
      const { ensureCallbackQueueTab } = await loadFreshNotify();
      const result = await ensureCallbackQueueTab();
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/not configured/i);
    });

    it('returns {ok:false} when Google credentials are missing', async () => {
      delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      const { ensureCallbackQueueTab } = await loadFreshNotify();
      const result = await ensureCallbackQueueTab();
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/credentials/i);
    });
  });

  describe('logCallbackRequest', () => {
    it('writes a row with all expected fields in column order', async () => {
      const { logCallbackRequest } = await loadFreshNotify();
      const result = await logCallbackRequest({
        callerPhone: '+19175551234',
        location: 'brickell',
        originalAutotextSid: 'SM_test_123',
        requestedVia: 'CALLBACK_keyword',
        messageBody: 'CALLBACK',
      });
      expect(result.ok).toBe(true);

      const appendCall = state.calls.valuesAppend[0];
      expect(appendCall).toBeDefined();
      expect(appendCall.range).toBe('CallbackQueue!A:K');
      const row = appendCall.requestBody.values[0];
      expect(row).toHaveLength(11);
      expect(row[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(String(row[1])).toMatch(/\d{2}:\d{2}/);
      expect(row[2]).toBe('+19175551234');
      expect(row[3]).toBe('(XXX) XXX-1234');
      expect(row[4]).toBe('brickell');
      expect(row[5]).toBe('SM_test_123');
      expect(row[6]).toBe('CALLBACK_keyword');
      expect(row[7]).toBe('pending');
      expect(row[8]).toBe('');
      expect(row[9]).toBe('');
      expect(row[10]).toBe('');
    });

    it('masks phone correctly in the row', async () => {
      const { logCallbackRequest } = await loadFreshNotify();
      await logCallbackRequest({
        callerPhone: '+13055559999',
        location: 'brickell',
        originalAutotextSid: 'SM_test',
        requestedVia: 'natural_language',
      });
      const row = state.calls.valuesAppend[0].requestBody.values[0];
      expect(row[3]).toBe('(XXX) XXX-9999');
    });

    it('defaults requestedVia to natural_language when not provided', async () => {
      const { logCallbackRequest } = await loadFreshNotify();
      await logCallbackRequest({
        callerPhone: '+19175551234',
        location: 'brickell',
        originalAutotextSid: 'SM_test',
      });
      const row = state.calls.valuesAppend[0].requestBody.values[0];
      expect(row[6]).toBe('natural_language');
    });

    it('throws when callerPhone is missing', async () => {
      const { logCallbackRequest } = await loadFreshNotify();
      await expect(logCallbackRequest({
        location: 'brickell',
        originalAutotextSid: 'SM_test',
      })).rejects.toThrow(/callerPhone/);
    });

    it('throws when location is missing', async () => {
      const { logCallbackRequest } = await loadFreshNotify();
      await expect(logCallbackRequest({
        callerPhone: '+19175551234',
        originalAutotextSid: 'SM_test',
      })).rejects.toThrow(/location/);
    });

    it('throws when GOOGLE_CHATLOG_SHEET_ID is not configured', async () => {
      delete process.env.GOOGLE_CHATLOG_SHEET_ID;
      const { logCallbackRequest } = await loadFreshNotify();
      await expect(logCallbackRequest({
        callerPhone: '+19175551234',
        location: 'brickell',
        originalAutotextSid: 'SM_test',
      })).rejects.toThrow(/GOOGLE_CHATLOG_SHEET_ID/);
    });

    it('returns the row number parsed from the append response', async () => {
      const { logCallbackRequest } = await loadFreshNotify();
      state.appendResponseRange = 'CallbackQueue!A5:K5';
      const result = await logCallbackRequest({
        callerPhone: '+19175551234',
        location: 'brickell',
        originalAutotextSid: 'SM_test',
        requestedVia: 'CALLBACK_keyword',
      });
      expect(result.rowNumber).toBe(5);
    });
  });
});
