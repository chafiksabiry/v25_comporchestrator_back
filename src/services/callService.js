class CallService {
  async handleIncomingCall(telnyx, callControlId) {
    await telnyx.calls.speak({
      call_control_id: callControlId,
      language: 'en-US',
      voice: 'female',
      payload: 'Welcome to our service. Please hold while we connect you with an agent.'
    });
  }

  async initiateCall(telnyx, connectionId, to, from, baseUrl) {
    return await telnyx.calls.create({
      connection_id: connectionId,
      to,
      from,
      answer_url: `${baseUrl}/api/calls/answer`
    });
  }

  async hangupCall(telnyx, callControlId) {
    await telnyx.calls.hangup({
      call_control_id: callControlId
    });
  }

  async startRecording(telnyx, callControlId) {
    await telnyx.calls.record_start({
      call_control_id: callControlId,
      format: 'mp3',
      channels: 'single'
    });
  }

  async stopRecording(telnyx, callControlId) {
    await telnyx.calls.record_stop({
      call_control_id: callControlId
    });
  }
}

export const callService = new CallService(); 