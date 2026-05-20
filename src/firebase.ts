import { initializeApp } from 'firebase/app';
import { getAuth, initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence, browserPopupRedirectResolver } from 'firebase/auth';
import { initializeFirestore, doc, getDocFromServer } from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
  useFetchStreams: false,
} as any, firebaseConfig.firestoreDatabaseId);

let authInstance;
try {
  // Tentativa de inicializar com fallback de persistência caso IndexedDB esteja bloqueado (Navegador Anônimo/Storage Partitioned)
  authInstance = initializeAuth(app, {
    persistence: [indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence],
    popupRedirectResolver: browserPopupRedirectResolver
  });
} catch (e) {
  // Se falhar o initializeAuth (provavelmente ambiente muito restrito), faz fallback pro getAuth default
  console.error("Erro na inicialização personalizada de auth. Usando padrão.", e);
  authInstance = getAuth(app);
}

export const auth = authInstance;

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if(error instanceof Error && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration.");
    }
  }
}
testConnection();
