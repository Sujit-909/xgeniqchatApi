// Notification Service placeholder. Replace `deliver` with FCM / APNs / VoIP push in production.
export class NotificationService {
  constructor() { this.sent = []; }
  deliver(userId, payload) {
    this.sent.push({ userId, payload, at: Date.now() });
    if (this.sent.length > 1000) this.sent.shift();
  }
}
