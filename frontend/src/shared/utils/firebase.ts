import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
const firebaseConfig = {
  projectId: 'pulsara-devops-dash',
  appId: '1:117356603974:web:cd18b5b2ce5731ac55f847',
  storageBucket: 'pulsara-devops-dash.firebasestorage.app',
  apiKey: 'AIzaSyDx6vKP0ga8sYnH15cbSqds-huwx6IL0G0',
  authDomain: 'pulsara-devops-dash.firebaseapp.com',
  messagingSenderId: '117356603974'
};
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
