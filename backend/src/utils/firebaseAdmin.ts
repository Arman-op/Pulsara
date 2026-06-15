import * as admin from 'firebase-admin';
// Initialize firebase-admin
// Since we are only using it to verify tokens, the projectId is sufficient
// in most environments. If you need to access Firestore or other services
// from the backend, you'd need service account credentials.
admin.initializeApp({
  projectId: 'pulsara-devops-dash',
});
export default admin;