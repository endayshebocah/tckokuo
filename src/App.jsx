import React, { useState, useEffect, useRef, useCallback, useMemo, useContext, createContext } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInAnonymously } from 'firebase/auth';
import { getFirestore, collection, query, onSnapshot, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, where, getDocs, writeBatch, Timestamp, setDoc, arrayUnion, arrayRemove } from 'firebase/firestore';

// =================================================================================
// KONFIGURASI & HELPERS
// =================================================================================

const firebaseConfig = {
  apiKey: "AIzaSyB6NiW14iWhlhIRE8ViXYEOS5SMvGd2Yq4",
  authDomain: "database-parfum-fd2f8.firebaseapp.com",
  projectId: "database-parfum-fd2f8",
  storageBucket: "database-parfum-fd2f8.appspot.com",
  messagingSenderId: "461710865000",
  appId: "1:461710865000:web:fb0d043d07997c986c01dd"
};
const appId = 'hasil-ceking-peserta-kokuo-v2';

const availablePermissions = [
    { key: 'daftarHadir', label: 'Daftar Hadir Peserta' },
    { key: 'tindakLanjut', label: 'Tindak Lanjut' },
    { key: 'hasilKerja', label: 'Hasil Kerja Trainer' },
    { key: 'rangkumanKeahlian', label: 'Rangkuman Keahlian' },
    { key: 'komplainan', label: 'Komplainan' },
    { key: 'perbaikanData', label: 'Perbaikan Data' },
    { key: 'trash', label: 'Tong Sampah' }, { key: 'hapusBeberapa', label: 'Hapus Beberapa Data' },
    { key: 'izinAkses', label: 'Manajemen Izin Akses', adminOnly: true },
];

const compressImage = (base64Str, maxWidth = 600, maxHeight = 600) => {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.src = base64Str;
        img.onload = () => {
            const canvas = document.createElement('canvas');
            let { width, height } = img;
            if (width > height) { if (width > maxWidth) { height *= maxWidth / width; width = maxWidth; } } 
            else { if (height > maxHeight) { width *= maxHeight / height; height = maxHeight; } }
            canvas.width = width; canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/jpeg', 0.7)); 
        };
        img.onerror = (error) => reject(error);
    });
};

const determineDisplayStatus = (record) => {
    if (!record || !record.status) return 'Status Tidak Diketahui';
    const { status, evaluationResult, cekingResult } = record;
    if (status.startsWith('Evaluasi')) {
        const evalName = status.replace('Evaluasi ', '');
        return evaluationResult === 'Lulus' ? `Lulus Evaluasi ${evalName}` : `Masih Tahap Evaluasi ${evalName}`;
    }
    if (status.startsWith('Ceking tahap')) {
         return cekingResult === 'Lulus' ? `Lulus Ceking` : 'Tahap Ceking';
    }
    return status;
};

const getNextCekingStage = (nama, activeRecords) => {
    if (!nama) return "Ceking tahap 1";
    const participantCekingRecords = activeRecords
        .filter(r => r.nama === nama && r.status.match(/Ceking tahap \d+/))
        .map(r => parseInt(r.status.replace('Ceking tahap ', ''), 10))
        .filter(num => !isNaN(num));

    if (participantCekingRecords.length === 0) return "Ceking tahap 1";
    return `Ceking tahap ${Math.max(...participantCekingRecords) + 1}`;
};

const matchesStatusFilter = (record, filter) => {
    if (!filter || filter === 'semua') return true;
    const displayStatus = determineDisplayStatus(record);
    switch (filter) {
        case 'Trainingan': return record.status.startsWith('Training');
        case 'Ceking': return displayStatus === 'Tahap Ceking';
        case 'Resign': return record.status === 'Resign';
        case 'Ganti Peserta': return record.status === 'Ganti Peserta';
        default: return true;
    }
};

const matchesEvaluationCategoryFilter = (record, filter) => {
    if (!filter || filter === 'semua') return true;
    if (record.status === filter) return true; // Mencocokkan status evaluasi eksplisit
    // Jika memfilter evaluasi pertama, sertakan juga lulusan baru dari TC
    if (filter === 'Evaluasi Reflexology' && record.status === 'Lulus') {
        return true;
    }
    return false;
};

const formatFirebaseTimestamp = (timestamp) => {
    if (!timestamp || typeof timestamp.toDate !== 'function') return { date: 'N/A', time: 'N/A' };
    const date = timestamp.toDate();
    return {
        date: date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }),
        time: date.toLocaleTimeString('en-GB')
    };
};

const formatDateString = (dateString) => {
    if (!dateString) return 'N/A';
    try {
        const date = new Date(`${dateString}T00:00:00Z`); // Use Z for UTC to avoid timezone issues
        if (isNaN(date.getTime())) return 'Tanggal Tidak Valid';
        return date.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    } catch (error) { return 'Gagal Memformat'; }
};

const SpinnerIcon = () => (
    <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
    </svg>
);

// =================================================================================
// Context API
// =================================================================================
const AppContext = createContext();

const AppProvider = ({ children }) => {
    const [db, setDb] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [isLoginDataReady, setIsLoginDataReady] = useState(false);
    const [isRecordsLoading, setIsRecordsLoading] = useState(true);
    const [records, setRecords] = useState([]);
    const [complaints, setComplaints] = useState([]);
    const [users, setUsers] = useState([]);
    const [toastMessage, setToastMessage] = useState('');
    const [currentUser, setCurrentUser] = useState(null);
    const [userRole, setUserRole] = useState(null);
    const [loginStep, setLoginStep] = useState('login');
    const [activityNotifications, setActivityNotifications] = useState([]);
    const [recordToAutoEdit, setRecordToAutoEdit] = useState(null);
    const [lastSaveTimestamp, setLastSaveTimestamp] = useState(null);
    const [postSaveAction, setPostSaveAction] = useState(null);
    const [modal, setModal] = useState({ type: null, props: {} });
    const [dropdownOptions, setDropdownOptions] = useState({ cabangList: [], trainingDariList: [] });


    const app = useMemo(() => initializeApp(firebaseConfig), []);

    useEffect(() => {
        const firestoreDb = getFirestore(app);
        const auth = getAuth(app);
        setDb(firestoreDb);
        const unsubscribe = onAuthStateChanged(auth, (user) => {
            if (user) { setIsAuthReady(true); } 
            else { signInAnonymously(auth).catch((error) => console.error("Gagal masuk secara anonim:", error)); }
        });
        return () => unsubscribe();
    }, [app]);

    useEffect(() => {
        if (!db || !isAuthReady) return;
        
        const usersQuery = query(collection(db, `artifacts/${appId}/public/data/users`));
        const unsubUsers = onSnapshot(usersQuery, (snapshot) => {
            setUsers(snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id })));
            setIsLoginDataReady(true);
        });

        return () => { unsubUsers(); };
    }, [db, isAuthReady]);
    
    useEffect(() => {
        if (!db || !isAuthReady || !currentUser) {
            setRecords([]);
            setComplaints([]);
            setActivityNotifications([]);
            setIsRecordsLoading(true);
            return;
        }

        setIsRecordsLoading(true);

        const recordsQuery = query(collection(db, `artifacts/${appId}/public/data/records`));
        const unsubRecords = onSnapshot(recordsQuery, (snapshot) => {
            setRecords(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
            setIsRecordsLoading(false);
        }, () => setIsRecordsLoading(false));
        
        const complaintsQuery = query(collection(db, `artifacts/${appId}/public/data/complaints`));
        const unsubComplaints = onSnapshot(complaintsQuery, (snapshot) => {
            const fetchedComplaints = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            fetchedComplaints.sort((a,b) => (b.createdAt?.toDate() || 0) - (a.createdAt?.toDate() || 0));
            setComplaints(fetchedComplaints);
        });

        const oneWeekAgo = new Date();
        oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
        const notificationsQuery = query(collection(db, `artifacts/${appId}/public/data/notifications`), where('createdAt', '>=', Timestamp.fromDate(oneWeekAgo)));
        const unsubNotifications = onSnapshot(notificationsQuery, (snapshot) => {
            const notifs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setActivityNotifications(notifs.sort((a,b) => b.createdAt.toDate() - a.createdAt.toDate()));
        });

        const optionsDocRef = doc(db, `artifacts/${appId}/public/data/options`, 'dropdownOptions');
        const unsubOptions = onSnapshot(optionsDocRef, (docSnap) => {
            if (docSnap.exists()) {
                const data = docSnap.data();
                setDropdownOptions({
                    cabangList: data.cabangList?.sort() || [],
                    trainingDariList: data.trainingDariList?.sort() || []
                });
            } else {
                setDoc(optionsDocRef, { cabangList: [], trainingDariList: [] });
            }
        });

        return () => { unsubRecords(); unsubNotifications(); unsubOptions(); unsubComplaints(); };
    }, [db, isAuthReady, currentUser]);

    const showToast = useCallback((message) => {
        setToastMessage(message);
        setTimeout(() => setToastMessage(''), 3000);
    }, []);

    const openModal = useCallback((type, props = {}) => setModal({ type, props }), []);
    const closeModal = useCallback(() => setModal({ type: null, props: {} }), []);
    
    const value = { db, app, isAuthReady, isLoginDataReady, isRecordsLoading, records, users, complaints, dropdownOptions, showToast, currentUser, setCurrentUser, userRole, setUserRole, loginStep, setLoginStep, activityNotifications, recordToAutoEdit, setRecordToAutoEdit, lastSaveTimestamp, setLastSaveTimestamp, postSaveAction, setPostSaveAction, modal, openModal, closeModal };

    return (
        <AppContext.Provider value={value}>
            {children}
            {toastMessage && <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-blue-600 text-white px-6 py-3 rounded-full shadow-lg z-[100] animate-fade-in-up">{toastMessage}</div>}
        </AppContext.Provider>
    );
};


// =================================================================================
// CUSTOM HOOKS
// =================================================================================

const useFirestore = () => {
    const { db, currentUser, showToast } = useContext(AppContext);

    const addOrUpdateRecord = async (recordId, data) => {
        if (!db) return;
        try {
            if (recordId) {
                await updateDoc(doc(db, `artifacts/${appId}/public/data/records`, recordId), { ...data, updatedAt: serverTimestamp(), lastUpdatedByName: currentUser.nama });
                showToast("Data berhasil diperbarui!");
            } else {
                const newRecordRef = await addDoc(collection(db, `artifacts/${appId}/public/data/records`), { ...data, createdAt: serverTimestamp(), createdByName: currentUser.nama, isDeleted: false });
                showToast("Data berhasil ditambahkan!");
                let message = `${currentUser.nama} menambahkan peserta baru: ${data.nama}.`;
                if (data.status?.startsWith("Evaluasi")) {
                    message = `${currentUser.nama} menambahkan data evaluasi untuk ${data.nama}.`;
                } else if (data.status === "Lulus") {
                    message = `${currentUser.nama} menindaklanuti ${data.nama} sebagai Lulus.`;
                } else if (data.status === "Resign") {
                    message = `${currentUser.nama} mengubah status ${data.nama} menjadi Resign.`;
                }
                await addDoc(collection(db, `artifacts/${appId}/public/data/notifications`), {
                    message: message, type: 'Aktivitas Baru', createdAt: serverTimestamp(),
                    createdBy: currentUser.nama, recordId: newRecordRef.id
                });
            }
            return true;
        } catch (error) {
            showToast("Gagal menyimpan data.");
            console.error("Error saving record:", error);
            return false;
        }
    };
    
    const softDeleteRecord = async (recordId, name) => {
        if (!db) return;
        try {
            await updateDoc(doc(db, `artifacts/${appId}/public/data/records`, recordId), { isDeleted: true, updatedAt: serverTimestamp(), lastUpdatedByName: currentUser.nama });
            showToast(`Data untuk "${name}" telah dipindahkan ke tong sampah.`);
        } catch (error) { showToast("Gagal memindahkan data."); }
    };

    const restoreRecord = async (recordId) => {
        if (!db) return;
        try {
            await updateDoc(doc(db, `artifacts/${appId}/public/data/records`, recordId), { isDeleted: false, updatedAt: serverTimestamp() });
            showToast("Data berhasil dipulihkan.");
        } catch (error) { showToast("Gagal memulihkan data."); }
    };
    
    const deleteRecordPermanent = async (recordId, name) => {
        if (!db) return;
        try {
            await deleteDoc(doc(db, `artifacts/${appId}/public/data/records`, recordId));
            showToast(`Data untuk "${name}" telah dihapus permanen.`);
        } catch (error) {
            showToast("Gagal menghapus data secara permanen.");
            console.error("Error permanent delete:", error);
        }
    };

    const addOrUpdateUser = async (userId, data) => {
        if (!db) return;
        try {
            if (userId) {
                await updateDoc(doc(db, `artifacts/${appId}/public/data/users`, userId), data);
                showToast("Pengguna berhasil diperbarui.");
            } else {
                await addDoc(collection(db, `artifacts/${appId}/public/data/users`), data);
                showToast("Pengguna baru berhasil ditambahkan.");
            }
            return true;
        } catch (error) {
            showToast("Gagal menyimpan data pengguna.");
            return false;
        }
    };
    
    const deleteUser = async (userId, userName) => {
        if (!db) return;
        try {
            await deleteDoc(doc(db, `artifacts/${appId}/public/data/users`, userId));
            showToast(`Pengguna "${userName}" berhasil dihapus.`);
        } catch (error) { showToast("Gagal menghapus pengguna."); }
    };

    const mergeMasterData = async (fieldToFix, incorrectValue, correctValue) => {
        if (!db) return;
        showToast(`Memproses penggabungan untuk "${incorrectValue}"...`);
        
        try {
            const recordsRef = collection(db, `artifacts/${appId}/public/data/records`);
            const q = query(recordsRef, where(fieldToFix, "==", incorrectValue));
            const querySnapshot = await getDocs(q);
            
            if (querySnapshot.empty) {
                showToast("Tidak ada data yang cocok untuk diperbaiki.");
                return true;
            }

            const batch = writeBatch(db);
            querySnapshot.forEach(docSnapshot => {
                const docRef = doc(db, `artifacts/${appId}/public/data/records`, docSnapshot.id);
                batch.update(docRef, { [fieldToFix]: correctValue });
            });

            await batch.commit();
            showToast(`${querySnapshot.size} data berhasil diperbarui dan digabungkan.`);
            return true;
        } catch (error) {
            console.error("Error merging master data:", error);
            showToast("Gagal menggabungkan data.");
            return false;
        }
    };

    const updateDropdownOptions = async (fieldKey, value, action) => {
        if (!db) return;
        const docRef = doc(db, `artifacts/${appId}/public/data/options`, 'dropdownOptions');
        try {
            if (action === 'add') {
                await updateDoc(docRef, { [fieldKey]: arrayUnion(value) });
                showToast(`Opsi "${value}" berhasil ditambahkan.`);
            } else if (action === 'remove') {
                await updateDoc(docRef, { [fieldKey]: arrayRemove(value) });
                showToast(`Opsi "${value}" berhasil dihapus.`);
            }
            return true;
        } catch (error) {
            showToast("Gagal memperbarui daftar opsi.");
            console.error("Error updating dropdown options: ", error);
            return false;
        }
    };
    
    const addOrUpdateComplaint = async (complaintId, data) => {
        if (!db) return;
        try {
            if (complaintId) {
                await updateDoc(doc(db, `artifacts/${appId}/public/data/complaints`, complaintId), { ...data, updatedAt: serverTimestamp() });
                showToast("Komplain berhasil diperbarui!");
            } else {
                await addDoc(collection(db, `artifacts/${appId}/public/data/complaints`), { ...data, createdAt: serverTimestamp() });
                showToast("Komplain baru berhasil ditambahkan!");
            }
            return true;
        } catch (error) {
            showToast("Gagal menyimpan komplain.");
            console.error("Error saving complaint:", error);
            return false;
        }
    };

    const deleteComplaint = async (complaintId) => {
        if (!db) return;
        try {
            await deleteDoc(doc(db, `artifacts/${appId}/public/data/complaints`, complaintId));
            showToast("Komplain berhasil dihapus.");
            return true;
        } catch (error) {
            showToast("Gagal menghapus komplain.");
            console.error("Error deleting complaint:", error);
            return false;
        }
    };

    return { addOrUpdateRecord, softDeleteRecord, restoreRecord, deleteRecordPermanent, addOrUpdateUser, deleteUser, mergeMasterData, updateDropdownOptions, addOrUpdateComplaint, deleteComplaint };
};

const useRecords = (searchTerm, selectedBranchFilter, activeView) => {
    const { records } = useContext(AppContext);

    const allRecords = useMemo(() => records, [records]);
    const activeRecords = useMemo(() => allRecords.filter(r => !r.isDeleted), [allRecords]);
    const deletedRecords = useMemo(() => allRecords.filter(r => r.isDeleted), [allRecords]);

    const uniqueLatestRecords = useMemo(() => {
        const groupedByName = activeRecords.reduce((acc, record) => {
            if (!acc[record.nama]) acc[record.nama] = [];
            acc[record.nama].push(record);
            return acc;
        }, {});
        return Object.values(groupedByName).map(userRecords => 
            userRecords.sort((a, b) => (b.updatedAt?.toDate() || b.createdAt?.toDate() || 0) - (a.updatedAt?.toDate() || a.createdAt?.toDate() || 0))[0]
        );
    }, [activeRecords]);
    
    const recordsWithPhotos = useMemo(() => {
        const photoMap = new Map();
        activeRecords.slice().sort((a,b) => (a.createdAt?.toDate() || 0) - (b.createdAt?.toDate() || 0)).forEach(record => {
            if (record.nama && record.photo && !photoMap.has(record.nama)) {
                photoMap.set(record.nama, record.photo);
            }
        });
        return uniqueLatestRecords.map(record => ({ ...record, photo: photoMap.get(record.nama) || record.photo }));
    }, [activeRecords, uniqueLatestRecords]);

    const searchedRecords = useMemo(() => recordsWithPhotos.filter(record => 
        record.nama.toLowerCase().includes(searchTerm.toLowerCase())
    ), [recordsWithPhotos, searchTerm]);
    
    const filteredRecords = useMemo(() => {
        if (selectedBranchFilter === 'semua') return searchedRecords;
        
        switch (activeView) {
            case 'peserta':
                return searchedRecords.filter(r => r.trainganDari === selectedBranchFilter);
            case 'cabang':
            case 'jadwal':
                return searchedRecords.filter(r => r.turunKeCabang === selectedBranchFilter || r.cabang === selectedBranchFilter);
            default:
                return searchedRecords;
        }
    }, [searchedRecords, selectedBranchFilter, activeView]);

    const allFilterOptions = useMemo(() => {
        const branches = [...new Set(recordsWithPhotos.map(r => r.turunKeCabang || r.cabang).filter(Boolean))];
        const tcs = [...new Set(recordsWithPhotos.map(r => r.trainganDari).filter(Boolean))];
        return { cabang: branches.sort(), tc: tcs.sort() };
    }, [recordsWithPhotos]);
    
    const attendanceParticipants = useMemo(() => {
        return uniqueLatestRecords.filter(p => p.status.startsWith('Training') || p.status.startsWith('Ceking tahap'));
    }, [uniqueLatestRecords]);

    return { allRecords, activeRecords, deletedRecords, uniqueLatestRecords, filteredRecords, allFilterOptions, attendanceParticipants };
};

const useForm = (initialState, uniqueLatestRecords, allRecords, currentUser) => {
    const [formValues, setFormValues] = useState(initialState);
    const [recordToEdit, setRecordToEdit] = useState(null);
    const [nameSuggestions, setNameSuggestions] = useState([]);

    const handleFormInputChange = useCallback((e) => {
        const { name, value } = e.target;
        setFormValues(prev => ({ ...prev, [name]: value }));
        if (name === 'nama' && value.trim() !== '') {
            const filtered = uniqueLatestRecords.filter(record => record.nama.toLowerCase().includes(value.toLowerCase()));
            setNameSuggestions(filtered);
        } else {
            setNameSuggestions([]);
        }
    }, [uniqueLatestRecords]);

    const handleSuggestionClick = useCallback((record) => {
        const firstRecordWithPhoto = allRecords
            .filter(r => r.nama === record.nama && r.photo)
            .sort((a, b) => (a.createdAt?.toDate() || 0) - (b.createdAt?.toDate() || 0))[0];

        setFormValues({
            ...initialState,
            nama: record.nama,
            photo: firstRecordWithPhoto ? firstRecordWithPhoto.photo : (record.photo || null),
            trainer: currentUser?.nama || '',
        });
        setRecordToEdit(null);
        setNameSuggestions([]);
    }, [allRecords, initialState, currentUser]);

    const resetForm = useCallback(() => {
        setRecordToEdit(null);
        setFormValues(initialState);
    }, [initialState]);

    return { formValues, setFormValues, recordToEdit, setRecordToEdit, nameSuggestions, setNameSuggestions, handleFormInputChange, handleSuggestionClick, resetForm };
};

const useReports = (onEditParticipant, activeRecords) => {
    const { db, records, showToast, openModal } = useContext(AppContext);

    const handleFetchFollowUp = useCallback((startDate, endDate) => {
        if (!startDate || !endDate) { showToast("Silakan pilih rentang tanggal."); return; }
        const start = new Date(`${startDate}T00:00:00`);
        const end = new Date(`${endDate}T23:59:59`);
        const evaluationRecords = records.filter(r => r.status?.startsWith('Evaluasi') && r.tgl && new Date(r.tgl) >= start && new Date(r.tgl) <= end);
        const byBranch = evaluationRecords.reduce((acc, record) => {
            const branch = record.cabang || 'Lainnya';
            if (!acc[branch]) acc[branch] = {};
            if (!acc[branch][record.status]) acc[branch][record.status] = [];
            acc[branch][record.status].push({ nama: record.nama, evaluator: record.createdByName || 'N/A', tanggal: formatDateString(record.tgl) });
            return acc;
        }, {});
        openModal('followUpDetails', { data: byBranch });
    }, [records, showToast, openModal]);

    const handleShowTrainerDetail = useCallback((trainerName, allRecordsInRange) => {
        const trainerRecords = allRecordsInRange.filter(r => r.createdByName === trainerName);
        const workDataByBranch = trainerRecords.reduce((acc, record) => {
            const branch = record.cabang || record.turunKeCabang || record.trainganDari || 'Lainnya';
            if (!acc[branch]) acc[branch] = [];
            acc[branch].push(record);
            return acc;
        }, {});
        openModal('trainerWorkDetail', { trainerName, workData: workDataByBranch });
    }, [openModal]);

    const handleFetchTrainerPerformanceByDate = useCallback((startDate, endDate) => {
        if (!startDate || !endDate) { showToast("Silakan pilih rentang tanggal."); return; }
        const start = new Date(`${startDate}T00:00:00`);
        const end = new Date(`${endDate}T23:59:59`);
        
        const relevantRecords = records.filter(r => {
            const recordDate = r.createdAt?.toDate();
            return r.createdByName && recordDate >= start && recordDate <= end;
        });

        const performance = relevantRecords.reduce((acc, record) => {
            const trainer = record.createdByName;
            if (!acc[trainer]) { acc[trainer] = { total: 0, types: new Set() }; }
            acc[trainer].total++;
            acc[trainer].types.add(record.status.startsWith('Ceking') ? 'Ceking' : record.status);
            return acc;
        }, {});
        const performanceArray = Object.entries(performance).map(([trainerName, data]) => ({
            trainerName, total: data.total,
            summary: Array.from(data.types).slice(0, 2).join(', ') + (data.types.size > 2 ? '...' : '')
        })).sort((a, b) => b.total - a.total);
        
        openModal('trainerPerformanceList', { 
            performanceData: performanceArray, 
            onSelectTrainer: (trainerName) => handleShowTrainerDetail(trainerName, relevantRecords) 
        });
    }, [records, openModal, handleShowTrainerDetail, showToast]);

    const handleConfirmBulkDelete = useCallback(async (idsToDelete) => {
        if (!db) return;
        showToast(`Menghapus ${idsToDelete.length} data...`);
        const batch = writeBatch(db);
        idsToDelete.forEach(id => {
            const docRef = doc(db, `artifacts/${appId}/public/data/records`, id);
            batch.delete(docRef);
        });
        try {
            await batch.commit();
            showToast(`${idsToDelete.length} data berhasil dihapus secara permanen.`);
            openModal(null);
        } catch (error) {
            showToast("Gagal menghapus data.");
            console.error("Error performing bulk delete: ", error);
        }
    }, [db, showToast, openModal]);

    const handleFetchForBulkDelete = useCallback(async (startDate, endDate) => {
        if (!db || !startDate || !endDate) { showToast("Silakan pilih rentang tanggal yang valid."); return; }
        showToast("Mengambil data untuk dihapus...");
        const start = new Date(`${startDate}T00:00:00`);
        const end = new Date(`${endDate}T23:59:59`);
        const q = query(collection(db, `artifacts/${appId}/public/data/records`), where('createdAt', '>=', Timestamp.fromDate(start)), where('createdAt', '<=', Timestamp.fromDate(end)));
        try {
            const querySnapshot = await getDocs(q);
            const fetchedRecords = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            openModal('bulkDeleteData', { records: fetchedRecords, onConfirmDelete: handleConfirmBulkDelete });
            showToast(`${fetchedRecords.length} data ditemukan.`);
        } catch (error) {
            showToast("Gagal mengambil data.");
            console.error("Error fetching data for bulk delete: ", error);
        }
    }, [db, showToast, openModal, handleConfirmBulkDelete]);

    return {
        handleFetchFollowUp,
        handleFetchTrainerPerformanceByDate,
        handleFetchForBulkDelete
    };
};


// =================================================================================
// KOMPONEN-KOMPONEN UI
// =================================================================================

const LoadingSpinner = ({ fullScreen = true }) => (
    <div className={`flex flex-col items-center justify-center text-white ${fullScreen ? 'h-screen w-screen bg-gray-900' : 'py-20'}`}>
        <svg className="animate-spin h-12 w-12 text-blue-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <p className="mt-4 text-lg text-gray-400">Memuat data...</p>
    </div>
);

const ConfirmationDialog = ({ show, onClose, onConfirm, title, message, confirmText }) => {
    if (!show) return null;
    return (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-[80] p-4" onClick={onClose}>
            <div className="popup-wrapper popup-wrapper-visible bg-gray-800 p-8 rounded-xl shadow-neumorphic w-full max-w-sm space-y-4 border-2 border-yellow-500" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-xl font-bold text-center text-yellow-300">{title}</h3>
                <p className="text-center text-gray-300">{message}</p>
                <div className="flex justify-center gap-4 pt-4">
                    <button onClick={onClose} className="px-6 py-2 bg-gray-600 text-white font-bold rounded-lg hover:bg-gray-700">Batal</button>
                    <button onClick={onConfirm} className="px-6 py-2 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700">{confirmText}</button>
                </div>
            </div>
        </div>
    );
};

const FormValidationWarningPopup = ({ onClose, title, errors }) => (
    <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-[80] p-4" onClick={onClose}>
        <div className="popup-wrapper popup-wrapper-visible bg-gray-800 p-8 rounded-xl shadow-neumorphic w-full max-w-sm space-y-4 border-2 border-red-500" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-xl font-bold text-center text-red-300">{title}</h3>
            <div className="text-left text-gray-300 space-y-2">
                <p>Harap lengkapi kolom berikut:</p>
                <ul className="list-disc list-inside pl-2">
                    {errors.map((error, index) => <li key={index}>{error}</li>)}
                </ul>
            </div>
            <div className="flex justify-center pt-4">
                <button onClick={onClose} className="px-8 py-2 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700">Mengerti</button>
            </div>
        </div>
    </div>
);

const CekingCard = React.memo(({ record, onCardClick }) => {
    const displayStatus = determineDisplayStatus(record);
    const isLulus = displayStatus.startsWith('Lulus');
    const isResign = displayStatus === 'Resign' || record.status === 'Ganti Peserta';
    let statusStyle = 'text-yellow-400';
    if (isLulus) statusStyle = 'text-green-400';
    if (isResign) statusStyle = 'text-red-400';

    return (
        <div className={`bg-black rounded-xl shadow-neumorphic p-3 flex flex-col justify-between transition-all hover:scale-105 relative overflow-hidden w-44 flex-shrink-0`}>
            <div className={`absolute left-0 top-0 bottom-0 w-1.5 ${isLulus ? 'bg-green-500' : isResign ? 'bg-red-500' : 'bg-yellow-500'}`}></div>
            <div className="pl-3 h-full">
                <div className="cursor-pointer h-full flex flex-col" onClick={() => onCardClick(record)}>
                    <div className="w-full h-24 rounded-md bg-gray-700 flex items-center justify-center mb-2 overflow-hidden flex-shrink-0">
                        {record.photo ? <img src={record.photo} alt={record.nama} className="w-full h-full object-cover"/> : <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-gray-500" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clipRule="evenodd" /></svg>}
                    </div>
                    <div className="flex flex-col justify-start flex-grow">
                        <h3 className="text-base font-bold text-blue-300 truncate">{record.nama}</h3>
                        <p className="text-xs text-gray-300 mt-1"><strong>Trainer:</strong> {record.trainer || '-'}</p>
                        <p className="text-xs text-gray-300"><strong>Tgl Terakhir:</strong> {formatDateString(record.tanggalLulus || record.tgl)}</p>
                        <p className="text-xs text-gray-300"><strong>Status:</strong> <span className={`font-semibold ${statusStyle}`}>{displayStatus}</span></p>
                    </div>
                </div>
            </div>
        </div>
    );
});

const ParticipantDetailView = ({ participant, allRecords, onClose, onEdit, onDelete, onUpdateLatest }) => {
    const { userRole, showToast, db, openModal, closeModal, complaints } = useContext(AppContext);
    const [activeTab, setActiveTab] = useState('rincian');
    const [showAssessmentHistory, setShowAssessmentHistory] = useState(false);
    const [attendanceHistory, setAttendanceHistory] = useState([]);
    const [historyLoading, setHistoryLoading] = useState(false);

    // Moved guard clause to the top to prevent errors in hooks below
    if (!participant) return null;

    const handleDeleteClick = (recordId, name) => {
        openModal('confirmation', {
            title: "Konfirmasi Hapus",
            message: `Apakah Anda yakin ingin memindahkan data ${name} ke tong sampah?`,
            confirmText: "Ya, Hapus",
            onConfirm: () => {
                onDelete(recordId, name);
                closeModal();
                onClose();
            }
        });
    };

    const participantHistory = useMemo(() => {
        // Added guard clause to ensure allRecords is an array
        return (allRecords || [])
            .filter(r => r.nama === participant.nama && !r.isDeleted)
            .sort((a, b) => (a.createdAt?.toDate() || 0) - (b.createdAt?.toDate() || 0));
    }, [allRecords, participant]);
    
    const fullHistory = useMemo(() => {
        if (!participant.nama) return [];

        const recordsHistory = (allRecords || [])
            .filter(r => r.nama === participant.nama && !r.isDeleted)
            .map(r => ({ ...r, historyType: 'Record' }));

        const complaintHistory = (complaints || [])
            .filter(c => c.therapistName === participant.nama)
            .map(c => ({
                id: c.id,
                historyType: 'Complaint',
                createdAt: c.createdAt, 
                complaintDate: c.complaintDate, 
                details: c.complaintDetails,
                reportedBy: c.reportedBy,
            }));

        const combined = [...recordsHistory, ...complaintHistory];

        combined.sort((a, b) => {
            const dateA = a.historyType === 'Record' ? (a.updatedAt?.toDate() || a.createdAt?.toDate() || 0) : (a.createdAt?.toDate() || new Date(a.complaintDate));
            const dateB = b.historyType === 'Record' ? (b.updatedAt?.toDate() || b.createdAt?.toDate() || 0) : (b.createdAt?.toDate() || new Date(b.complaintDate));
            return new Date(dateB) - new Date(dateA);
        });
        
        return combined;
    }, [participant.nama, allRecords, complaints]);

    const assessmentHistory = useMemo(() => {
        return (allRecords || [])
            .filter(r => r.nama === participant.nama && !r.isDeleted && r.penilaian)
            .sort((a, b) => (b.updatedAt?.toDate() || b.createdAt?.toDate() || 0) - (a.updatedAt?.toDate() || a.createdAt?.toDate() || 0));
    }, [allRecords, participant]);

    const timelineSteps = useMemo(() => {
        const steps = new Set();
        participantHistory.forEach(rec => {
            if (rec.status.startsWith('Training')) steps.add(rec.status);
            if (rec.status.startsWith('Ceking tahap')) steps.add(rec.status);
            if (rec.status === 'Lulus') steps.add('Lulus');
            if (rec.status.startsWith('Evaluasi')) steps.add(rec.status);
        });
        const sortedSteps = Array.from(steps);
        sortedSteps.sort((a, b) => {
            const order = ['Training Reflexology', 'Training Athletic Massage', 'Training Seitai', 'Ceking tahap 1', 'Ceking tahap 2', 'Ceking tahap 3', 'Lulus', 'Evaluasi Reflexology', 'Evaluasi Athletic Massage', 'Evaluasi Seitai'];
            return order.indexOf(a) - order.indexOf(b);
        });
        return sortedSteps;
    }, [participantHistory]);
    
    const getRecordForStep = (step) => {
        if (step === 'Lulus') return participantHistory.find(r => r.status === 'Lulus');
        return participantHistory.find(r => r.status === step);
    };

    const [activeRecord, setActiveRecord] = useState(participant);
    
    const assessmentFields = [
        { key: 'ketepatanWaktu', label: 'Ketepatan Waktu/Attitude' },
        { key: 'bagianKaki', label: 'Bagian Kaki/Face Down' },
        { key: 'bagianTangan', label: 'Bagian Tangan/Face Up' },
        { key: 'bagianPunggung', label: 'Bagian Punggung/Side Lying' },
        { key: 'bagianPundak', label: 'Bagian Pundak/Adjustment' },
        { key: 'catatan', label: 'Catatan Tambahan' },
    ];

    const showAttendanceTab = useMemo(() => {
        const latestStatus = participant.status;
        return latestStatus === 'Trainingan' || latestStatus.startsWith('Ceking tahap');
    }, [participant.status]);

    useEffect(() => {
        if (!showAttendanceTab && activeTab === 'hadir') {
            setActiveTab('rincian');
        }
    }, [showAttendanceTab, activeTab]);
    
    useEffect(() => {
        if (activeTab !== 'hadir' || !db || !participant.nama) return;
        
        setHistoryLoading(true);
        const q = query(collection(db, `artifacts/${appId}/public/data/attendance`), where("participantName", "==", participant.nama));
        
        const unsubscribe = onSnapshot(q, (querySnapshot) => {
            const fetchedHistory = querySnapshot.docs.map(doc => doc.data());
            fetchedHistory.sort((a, b) => b.date.toDate() - a.date.toDate());
            setAttendanceHistory(fetchedHistory);
            setHistoryLoading(false);
        }, (error) => {
            console.error("Error fetching attendance history: ", error);
            showToast("Gagal memuat riwayat kehadiran.");
            setHistoryLoading(false);
        });
        
        return () => unsubscribe();
    }, [activeTab, db, participant.nama, showToast]);

    const handleTimelineClick = (step) => {
        const recordForStep = getRecordForStep(step);
        if (recordForStep) {
            setActiveRecord(recordForStep);
            setShowAssessmentHistory(false);
            setActiveTab('rincian');
        } else {
            showToast(`Data untuk tahap "${step}" tidak ditemukan.`);
        }
    };
    
    const handleWorkDuration = () => {
        const allParticipantRecords = allRecords.filter(r => r.nama === participant.nama && !r.isDeleted);
        const firstRecord = allParticipantRecords.sort((a,b) => (a.createdAt?.toDate() || 0) - (b.createdAt?.toDate() || 0))[0];
        const resignRecord = allParticipantRecords.find(r => r.status === 'Resign');
        
        if (!firstRecord || !firstRecord.tanggalMasuk) {
            showToast("Tanggal masuk tidak ditemukan.");
            return;
        }

        const startDate = new Date(firstRecord.tanggalMasuk);
        const endDate = resignRecord && resignRecord.tanggalResign ? new Date(resignRecord.tanggalResign) : new Date();
        
        let years = endDate.getFullYear() - startDate.getFullYear();
        let months = endDate.getMonth() - startDate.getMonth();
        let days = endDate.getDate() - startDate.getDate();

        if (days < 0) { months--; days += new Date(endDate.getFullYear(), endDate.getMonth(), 0).getDate(); }
        if (months < 0) { years--; months += 12; }
        
        showToast(`Masa kerja: ${years} tahun, ${months} bulan, ${days} hari.`);
    };

    const renderRincianTab = () => {
        const { status, nama, kotaAsal, tanggalMasuk, refrensi, trainganDari, trainer, tahapCeking, tgl, tanggalLulus, turunKeCabang, accYangMeluluskan, cabang } = activeRecord;
        let details;
        if (status.startsWith('Training')) {
            details = (<>
                <p><strong className="text-gray-400">Nama:</strong> {nama || '-'}</p>
                <p><strong className="text-gray-400">Status:</strong> {status || '-'}</p>
                <p><strong className="text-gray-400">Kota Asal:</strong> {kotaAsal || '-'}</p>
                <p><strong className="text-gray-400">Tanggal Masuk:</strong> {formatDateString(tanggalMasuk)}</p>
                <p><strong className="text-gray-400">Refrensi:</strong> {refrensi || '-'}</p>
                <p><strong className="text-gray-400">Training Dari:</strong> {trainganDari || '-'}</p>
                {cabang && <p><strong className="text-gray-400">Cabang:</strong> {cabang}</p>}
            </>);
        } else if (status.startsWith('Ceking tahap')) {
             details = (<>
                <p><strong className="text-gray-400">Nama:</strong> {nama || '-'}</p>
                <p><strong className="text-gray-400">Status:</strong> {activeRecord.cekingResult === 'Lulus' ? `Lulus ${status}` : `Masih ${status}`}</p>
                <p><strong className="text-gray-400">Trainer:</strong> {trainer || '-'}</p>
                <p><strong className="text-gray-400">Tahap Ceking:</strong> {tahapCeking || status}</p>
                <p><strong className="text-gray-400">Tanggal Ceking:</strong> {formatDateString(tgl)}</p>
                <p><strong className="text-gray-400">Training Dari:</strong> {trainganDari || '-'}</p>
            </>);
        } else if (status === 'Lulus') {
            details = (<>
                <p><strong className="text-gray-400">Nama:</strong> {nama || '-'}</p>
                <p><strong className="text-gray-400">Status:</strong> {status || '-'}</p>
                <p><strong className="text-gray-400">Trainer:</strong> {trainer || '-'}</p>
                <p><strong className="text-gray-400">Tahap Ceking:</strong> {tahapCeking || '-'}</p>
                <p><strong className="text-gray-400">Tanggal Lulus:</strong> {formatDateString(tanggalLulus)}</p>
                <p><strong className="text-gray-400">Turun ke Cabang:</strong> {turunKeCabang || '-'}</p>
                <p><strong className="text-gray-400">Acc Yang Meluluskan:</strong> {accYangMeluluskan || '-'}</p>
                <p><strong className="text-gray-400">Training Dari:</strong> {trainganDari || '-'}</p>
            </>);
        } else if (status.startsWith('Evaluasi')) {
            details = (<>
                <p><strong className="text-gray-400">Nama:</strong> {nama || '-'}</p>
                <p><strong className="text-gray-400">Status:</strong> {determineDisplayStatus(activeRecord)}</p>
                <p><strong className="text-gray-400">Trainer:</strong> {trainer || '-'}</p>
                <p><strong className="text-gray-400">Tahap Ceking:</strong> {tahapCeking || '-'}</p>
                <p><strong className="text-gray-400">Tanggal Evaluasi:</strong> {formatDateString(tgl)}</p>
                <p><strong className="text-gray-400">Cabang:</strong> {cabang || '-'}</p>
            </>);
        } else {
             details = <p>Rincian tidak tersedia untuk status ini.</p>;
        }

        return (
            <>
                <h2 className="text-xl font-bold text-white mb-4 text-center">Rincian Peserta - <span className="text-yellow-300">{determineDisplayStatus(activeRecord)}</span></h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm mb-4 text-gray-300">{details}</div>
                <div className="horizontal-scroll-container flex overflow-x-auto gap-2 p-1 mb-4">
                    {timelineSteps.map(step => (<button key={step} onClick={() => handleTimelineClick(step)} className={`px-3 py-1 text-xs font-semibold rounded-md whitespace-nowrap ${activeRecord.status === step ? 'bg-blue-600 text-white' : 'bg-gray-600 text-gray-300'}`}>{step}</button>))}
                </div>
                {showAssessmentHistory && (
                    <div className="my-4 p-4 bg-gray-900/50 rounded-lg max-h-64 overflow-y-auto">
                        <h3 className="text-lg font-semibold text-purple-300 mb-3 text-center">Riwayat Penilaian</h3>
                        <div className="space-y-4 pr-2">
                            {assessmentHistory.length > 0 ? (
                                assessmentHistory.map(record => (
                                    <div key={record.id} className="bg-gray-800/70 p-3 rounded-lg">
                                        <div className="flex justify-between items-baseline mb-2">
                                            <h4 className="font-bold text-base text-white">{determineDisplayStatus(record)}</h4>
                                            <p className="text-xs text-blue-300">{formatFirebaseTimestamp(record.updatedAt || record.createdAt).date}</p>
                                        </div>
                                        {record.penilaian?.ratings ? (
                                            <>
                                                <div className="space-y-2 text-sm mb-3">
                                                    {Object.entries(record.penilaian.ratings).map(([key, value]) => value && (
                                                        <div key={key} className="border-b border-gray-700 py-1">
                                                            <div className="flex justify-between items-center">
                                                                <span className="text-gray-400 capitalize">{key.replace(/([A-Z])/g, ' $1')}:</span>
                                                                <span className={`font-semibold px-2 py-0.5 rounded-full text-xs ${value === 'Baik' ? 'bg-green-500/50 text-green-200' : value === 'Cukup' ? 'bg-yellow-500/50 text-yellow-200' : 'bg-red-500/50 text-red-200'}`}>{value}</span>
                                                            </div>
                                                            {record.penilaian.manualNotes?.[key] && (
                                                                <p className="text-xs text-gray-300 mt-1 pl-2 border-l-2 border-gray-600">
                                                                    Catatan: {record.penilaian.manualNotes[key]}
                                                                </p>
                                                            )}
                                                        </div>
                                                    ))}
                                                </div>
                                                {record.penilaian.catatan && (
                                                     <div className="mt-2 pt-2 border-t border-gray-600">
                                                        <p className="text-sm font-semibold text-purple-300 mb-1">Ulasan Akhir:</p>
                                                        <p className="text-sm text-white bg-black/20 p-2 rounded-md">{record.penilaian.catatan}</p>
                                                    </div>
                                                )}
                                            </>
                                        ) : (
                                            <div className="space-y-1 text-sm">
                                                {assessmentFields.map(field => (
                                                    record.penilaian[field.key] && (
                                                        <div key={field.key} className="flex justify-between border-b border-gray-700 py-1 text-xs">
                                                            <span className="text-gray-400">{field.label}:</span>
                                                            <span className="text-white text-right">{record.penilaian[field.key]}</span>
                                                        </div>
                                                    )
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                ))
                            ) : (
                                <p className="text-center p-8 text-gray-400">Tidak ada riwayat penilaian ditemukan.</p>
                            )}
                        </div>
                    </div>
                )}
            </>
        );
    };
    
    const renderHadirTab = () => (
        <div className="max-h-96 overflow-y-auto">
            <h2 className="text-xl font-bold text-white mb-4 text-center">Riwayat Daftar Hadir</h2>
            {historyLoading ? (<p className="text-center p-8 text-gray-400">Memuat riwayat...</p>) : attendanceHistory.length > 0 ? (
                <table className="w-full text-left text-sm">
                    <thead className="bg-gray-900 sticky top-0"><tr><th className="p-2 font-semibold text-gray-300">Tanggal</th><th className="p-2 font-semibold text-gray-300">Status</th><th className="p-2 font-semibold text-gray-300">Keterangan</th></tr></thead>
                    <tbody className="bg-gray-800 divide-y divide-gray-700">
                        {attendanceHistory.map((item, index) => (<tr key={index} className="hover:bg-gray-700/50"><td className="p-2 whitespace-nowrap">{formatFirebaseTimestamp(item.date).date}</td><td className="p-2 whitespace-nowrap">{item.attendanceStatus}</td><td className="p-2">{item.notes || '-'}</td></tr>))}
                    </tbody>
                </table>) : (<p className="text-center p-8 text-gray-400">Tidak ada riwayat kehadiran ditemukan.</p>)}
        </div>
    );
    
    const renderLengkapTab = () => (
        <div className="max-h-96 overflow-y-auto pr-2">
            <h2 className="text-xl font-bold text-white mb-4 text-center">Riwayat Lengkap</h2>
            <div className="space-y-3">
                {fullHistory.length > 0 ? fullHistory.map((record) => {
                    if (record.historyType === 'Complaint') {
                        return (
                            <div key={record.id} className="bg-red-900/40 p-3 rounded-lg border-l-4 border-red-500">
                                <p className="font-bold text-lg text-red-300">Komplain</p>
                                <p className="text-sm text-red-200 mb-2">{formatDateString(record.complaintDate)}</p>
                                <p className="text-sm bg-black/30 p-2 rounded-md">{record.details}</p>
                                <p className="text-xs text-gray-400 mt-2 text-right">Dilaporkan oleh: {record.reportedBy || 'N/A'}</p>
                            </div>
                        );
                    }
                    return (
                        <div key={record.id} className="bg-gray-900/70 p-3 rounded-lg">
                            <p className="font-bold text-lg text-white">{determineDisplayStatus(record)}</p>
                            <p className="text-sm text-blue-300">{formatFirebaseTimestamp(record.updatedAt || record.createdAt).date}</p>
                            <p className="text-xs text-gray-400 mt-1">Diperbarui oleh: {record.lastUpdatedByName || record.createdByName || 'N/A'}</p>
                        </div>
                    );
                }) : (<p className="text-center p-8 text-gray-400">Tidak ada riwayat ditemukan.</p>)}
            </div>
        </div>
    );

    if (!participant) return null;
    
    return (
        <div className="mt-6 bg-gray-800 rounded-xl shadow-neumorphic w-full overflow-hidden border-2 border-blue-500 animate-fade-in-up-view">
            <div className="w-full h-80 bg-black flex items-center justify-center p-2 rounded-t-xl">
                {activeRecord.photo ? <img src={activeRecord.photo} alt={activeRecord.nama} className="max-w-full max-h-full object-contain" /> : <span className="text-gray-500">Tidak ada foto</span>}
            </div>
            <div className={`grid ${showAttendanceTab ? 'grid-cols-3' : 'grid-cols-2'}`}>
                {showAttendanceTab && (
                    <button onClick={() => setActiveTab('hadir')} className={`py-3 text-sm font-semibold border-b-2 ${activeTab === 'hadir' ? 'bg-indigo-600 border-indigo-400' : 'bg-gray-700 border-transparent hover:bg-gray-600'}`}>Riwayat Daftar Hadir</button>
                )}
                <button onClick={() => setActiveTab('rincian')} className={`py-3 text-sm font-semibold border-b-2 ${activeTab === 'rincian' ? 'bg-indigo-600 border-indigo-400' : 'bg-gray-700 border-transparent hover:bg-gray-600'}`}>Rincian</button>
                <button onClick={() => setActiveTab('lengkap')} className={`py-3 text-sm font-semibold border-b-2 ${activeTab === 'lengkap' ? 'bg-indigo-600 border-indigo-400' : 'bg-gray-700 border-transparent hover:bg-gray-600'}`}>Riwayat Lengkap</button>
            </div>
            <div className="p-4 md:p-6">
                {activeTab === 'rincian' && renderRincianTab()}
                {showAttendanceTab && activeTab === 'hadir' && renderHadirTab()}
                {activeTab === 'lengkap' && renderLengkapTab()}
                
                <div className="flex flex-col sm:flex-row justify-between items-center gap-4 mt-6">
                    <div className="flex flex-wrap gap-2">
                       {activeRecord.status === 'Trainingan' && <button onClick={handleWorkDuration} className="px-3 py-2 text-xs bg-green-600 rounded-lg hover:bg-green-700">Masa Kerja</button>}
                       <button onClick={() => setShowAssessmentHistory(p => !p)} className="px-3 py-2 text-xs bg-purple-600 rounded-lg hover:bg-purple-700">
                           {showAssessmentHistory ? 'Sembunyikan Penilaian' : 'Tampilkan Penilaian'}
                       </button>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                       <button onClick={() => { onUpdateLatest(activeRecord); onClose(); }} className="px-4 py-2 text-sm bg-green-600 text-white font-semibold rounded-lg hover:bg-green-700">Update Terbaru</button>
                       <button onClick={() => { onEdit(activeRecord); onClose(); }} className="px-4 py-2 text-sm bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700">Perbaiki</button>
                       {userRole === 'admin' && (
                            <button title="Hapus" onClick={() => handleDeleteClick(activeRecord.id, activeRecord.nama)} className="p-2 bg-red-600 text-white rounded-lg hover:bg-red-700"><svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 012 0v6a1 1 0 11-2 0V8z" clipRule="evenodd" /></svg></button>
                       )}
                       <button onClick={onClose} className="px-6 py-2 text-sm bg-gray-600 text-white font-semibold rounded-lg hover:bg-gray-700">Tutup</button>
                    </div>
                </div>
            </div>
        </div>
    );
};

const EvaluationCard = React.memo(({ record, onFollowUp, onCardClick }) => {
    const displayStatus = determineDisplayStatus(record);
    
    const lastDateStr = record.tanggalLulus || record.tgl;
    let dueDateText = 'N/A';
    if (lastDateStr) {
        const lastDate = new Date(`${lastDateStr}T00:00:00Z`);
        if (!isNaN(lastDate.getTime())) {
            const dueDate = new Date(lastDate);
            dueDate.setMonth(dueDate.getMonth() + 3);
            dueDateText = dueDate.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
        }
    }

    return (
        <div className={`bg-black rounded-xl shadow-neumorphic p-3 flex flex-col justify-between transition-all hover:scale-105 relative overflow-hidden w-44 flex-shrink-0`}>
            <div className={`absolute left-0 top-0 bottom-0 w-1.5 bg-purple-500`}></div>
            <div className="pl-3 flex flex-col h-full">
                <div className="flex-grow cursor-pointer" onClick={() => onCardClick(record)}>
                     <div className="w-full h-24 rounded-md bg-gray-700 flex items-center justify-center mb-2 overflow-hidden">
                        {record.photo ? <img src={record.photo} alt={record.nama} className="w-full h-full object-cover"/> : <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-gray-500" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clipRule="evenodd" /></svg>}
                    </div>
                    <h3 className="text-base font-bold text-blue-300 truncate">{record.nama}</h3>
                    <p className="text-xs text-gray-300 mt-1"><strong>Cabang:</strong> {record.turunKeCabang || record.cabang || '-'}</p>
                    <p className="text-xs text-gray-300"><strong>Status Saat Ini:</strong> <span className={`font-semibold text-yellow-400`}>{displayStatus}</span></p>
                    <p className="text-xs text-gray-300"><strong>Jatuh Tempo:</strong> <span className="font-bold text-red-400">{dueDateText}</span></p>
                </div>
                <div className="flex justify-end gap-1 mt-2">
                    <button title="Tindak Lanjut Evaluasi" onClick={() => onFollowUp(record)} className="w-full px-3 py-1.5 bg-purple-600 text-white rounded-md hover:bg-purple-700 shadow-inner-custom text-xs font-semibold">Tindak Lanjut</button>
                </div>
            </div>
        </div>
    );
});

const SkillsSummaryPopup = ({ onClose, allRecords, activeParticipants }) => {
    const skillsAnalysis = useMemo(() => {
        const analysis = { masters: [], reflexologyOnly: [], athleticOnly: [], byBranch: {} };
        if (!activeParticipants || !allRecords) return analysis;

        const recordsByName = allRecords.reduce((acc, record) => {
            if (!record.isDeleted) {
                const name = record.nama;
                if (!acc[name]) {
                    acc[name] = [];
                }
                acc[name].push(record);
            }
            return acc;
        }, {});

        const relevantParticipants = activeParticipants.filter(p => {
            const isTraining = p.status.startsWith('Training');
            const isCeking = p.status.startsWith('Ceking tahap') || p.status === 'Tahap Ceking';
            const isResign = p.status === 'Resign' || p.status === 'Ganti Peserta';
            return !isTraining && !isCeking && !isResign;
        });

        const participantSkills = relevantParticipants.map(participant => {
            const history = recordsByName[participant.nama] || [];
            const skills = new Set();
            history.forEach(rec => {
                if (rec.status === 'Lulus' || (rec.status === 'Evaluasi Reflexology' && rec.evaluationResult === 'Lulus')) skills.add('Reflexology');
                if (rec.status === 'Evaluasi Athletic Massage' && rec.evaluationResult === 'Lulus') skills.add('Athletic Massage');
                if (rec.status === 'Evaluasi Seitai' && rec.evaluationResult === 'Lulus') skills.add('Seitai');
            });
            return { ...participant, skills: Array.from(skills) };
        });

        participantSkills.forEach(p => {
            const hasReflex = p.skills.includes('Reflexology');
            const hasAthletic = p.skills.includes('Athletic Massage');
            const hasSeitai = p.skills.includes('Seitai');

            if (hasReflex && hasAthletic && hasSeitai) analysis.masters.push(p.nama);
            else if (hasReflex && !hasAthletic && !hasSeitai) analysis.reflexologyOnly.push(p.nama);
            else if (!hasReflex && hasAthletic && !hasSeitai) analysis.athleticOnly.push(p.nama);

            const branch = p.turunKeCabang || p.cabang || 'Belum Ditentukan';
            if (!analysis.byBranch[branch]) analysis.byBranch[branch] = [];
            analysis.byBranch[branch].push({ name: p.nama, skills: p.skills });
        });

        analysis.masters.sort();
        analysis.reflexologyOnly.sort();
        analysis.athleticOnly.sort();
        Object.values(analysis.byBranch).forEach(staffList => staffList.sort((a, b) => a.name.localeCompare(b.name)));
        return analysis;
    }, [allRecords, activeParticipants]);

    const SkillBadge = ({ skill }) => {
        let colorClass = 'bg-gray-600';
        if (skill === 'Reflexology') colorClass = 'bg-blue-600';
        if (skill === 'Athletic Massage') colorClass = 'bg-green-600';
        if (skill === 'Seitai') colorClass = 'bg-purple-600';
        return <span className={`text-sm font-semibold px-3 py-1 rounded-full text-white ${colorClass}`}>{skill}</span>;
    };
    
    const SpecialCategorySection = ({ title, count }) => (
        <div className="bg-gray-900/50 p-6 rounded-lg flex flex-col items-center justify-center text-center">
            <h3 className="text-lg font-bold text-yellow-300 mb-2">{title}</h3>
            <p className="text-5xl font-bold text-white">{count}</p>
        </div>
    );

    return (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-[70] p-4" onClick={onClose}>
            <div className="popup-wrapper popup-wrapper-visible bg-gray-800 p-6 rounded-xl shadow-neumorphic w-full max-w-6xl border-2 border-yellow-500 flex flex-col max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
                <h2 className="text-3xl font-bold text-center text-yellow-300 mb-6">Rangkuman Keahlian Staf</h2>
                <div className="flex-grow overflow-auto pr-2 space-y-8">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <SpecialCategorySection title="Master Semua Keahlian" count={skillsAnalysis.masters.length} />
                        <SpecialCategorySection title="Spesialis Reflexology" count={skillsAnalysis.reflexologyOnly.length} />
                        <SpecialCategorySection title="Spesialis Athletic Massage" count={skillsAnalysis.athleticOnly.length} />
                    </div>
                    <div>
                        <h3 className="text-2xl font-bold text-white mb-4">Rincian per Cabang</h3>
                        <div className="space-y-5">
                            {Object.entries(skillsAnalysis.byBranch).map(([branch, staff], index) => (
                                <div key={branch} className={`${index % 2 === 0 ? 'bg-gray-900/50' : 'bg-gray-800/60'} rounded-lg overflow-hidden border border-gray-700`}>
                                    <h4 className="text-2xl font-bold text-sky-300 bg-gray-700/50 px-5 py-4 flex justify-between items-center">
                                        <span>{branch}</span>
                                        <span className="text-base bg-sky-500 px-3 py-1 rounded-full">{staff.length} Staf</span>
                                    </h4>
                                    <div className="px-5 divide-y divide-gray-700/50">
                                        {staff.map(person => (
                                            <div key={person.name} className="flex flex-col sm:flex-row sm:items-center sm:justify-between py-4">
                                                <p className="font-bold text-lg text-white mb-2 sm:mb-0">{person.name}</p>
                                                <div className="flex flex-wrap gap-2">
                                                    {person.skills.length > 0 ? person.skills.map(skill => <SkillBadge key={skill} skill={skill} />) : <span className="text-xs text-gray-500">Belum ada keahlian</span>}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
                <div className="flex justify-end mt-6 pt-4 border-t border-gray-700"><button onClick={onClose} className="px-8 py-3 bg-gray-600 text-white font-bold rounded-lg hover:bg-gray-700">Tutup</button></div>
            </div>
        </div>
    );
};

const NotificationBellPopup = ({ onClose, evaluationNotifications, activityNotifications, onNotificationClick }) => {
    return (
        <div className="absolute top-full right-0 mt-2 w-80 bg-gray-700 rounded-lg shadow-lg z-30 border border-gray-600 p-2 space-y-2 max-h-96 overflow-y-auto">
            {activityNotifications.length > 0 && (
                <>
                    <h3 className="text-lg font-bold text-white px-2 pt-1">Aktivitas Baru</h3>
                    {activityNotifications.map(item => (
                        <div key={item.id} className="bg-gray-800 p-3 rounded-md cursor-pointer hover:bg-gray-700" onClick={() => onNotificationClick && onNotificationClick(item.recordId)}>
                            <p className="text-sm text-gray-200">{item.message}</p>
                            <p className="text-xs text-gray-400 text-right mt-1">{formatFirebaseTimestamp(item.createdAt).date}</p>
                        </div>
                    ))}
                    <div className="border-t border-gray-600 my-2"></div>
                </>
            )}

            {evaluationNotifications.length > 0 && (
                <>
                    <h3 className="text-lg font-bold text-white px-2">Jadwal Evaluasi</h3>
                    {evaluationNotifications.map(item => (
                        <div key={item.id} className="bg-gray-800 p-3 rounded-md cursor-pointer hover:bg-gray-700" onClick={() => onNotificationClick && onNotificationClick(item.id)}>
                            <p className="font-semibold text-blue-300">{item.nama}</p>
                            <p className="text-sm text-gray-300">Jadwal: <span className="font-medium text-yellow-400">{item.nextEvaluation}</span></p>
                            <p className="text-xs text-gray-400">Jatuh Tempo: {item.dueDate.toLocaleDateString('id-ID', {day: 'numeric', month: 'long'})}</p>
                        </div>
                    ))}
                </>
            )}
            
            {evaluationNotifications.length === 0 && activityNotifications.length === 0 && (
                 <p className="text-gray-400 text-center py-4">Tidak ada notifikasi.</p>
            )}
        </div>
    );
};

const BulkDeleteDateRangePopup = ({ onClose, onFetch }) => {
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');

    return (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 p-4" onClick={onClose}>
            <div className="popup-wrapper popup-wrapper-visible bg-gray-800 p-8 rounded-xl shadow-neumorphic w-full max-w-md space-y-6 border-2 border-red-500" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-2xl font-bold text-center text-red-300">Pilih Rentang Data untuk Dihapus</h3>
                <div className="space-y-4">
                    <div>
                        <label className="block mb-2 text-gray-300">Tanggal Mulai</label>
                        <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="w-full input-rounded-border" />
                    </div>
                    <div>
                        <label className="block mb-2 text-gray-300">Tanggal Selesai</label>
                        <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="w-full input-rounded-border" />
                    </div>
                </div>
                <button onClick={() => onFetch(startDate, endDate)} className="w-full px-6 py-3 bg-red-600 text-white font-bold rounded-xl text-lg hover:bg-red-700 shadow-neumorphic">Tampilkan Data</button>
                <button onClick={onClose} className="w-full mt-2 px-6 py-2 bg-gray-600 text-white font-bold rounded-xl hover:bg-gray-700">Tutup</button>
            </div>
        </div>
    );
};

const BulkDeleteDataPopup = ({ onClose, records, onConfirmDelete }) => {
    const [selectedIds, setSelectedIds] = useState(new Set());

    const handleSelectAll = (e) => {
        if (e.target.checked) {
            const allIds = new Set(records.map(r => r.id));
            setSelectedIds(allIds);
        } else {
            setSelectedIds(new Set());
        }
    };

    const handleSelectOne = (id) => {
        const newSelectedIds = new Set(selectedIds);
        if (newSelectedIds.has(id)) {
            newSelectedIds.delete(id);
        } else {
            newSelectedIds.add(id);
        }
        setSelectedIds(newSelectedIds);
    };

    const handleDelete = () => {
        if (selectedIds.size === 0) {
            return;
        }
        onConfirmDelete(Array.from(selectedIds));
    };

    return (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-[60] p-4" onClick={onClose}>
            <div className="popup-wrapper popup-wrapper-visible bg-gray-800 p-6 rounded-xl shadow-neumorphic w-full max-w-4xl border-2 border-red-500 flex flex-col max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
                <h2 className="text-2xl font-bold text-center text-red-300 mb-4 flex-shrink-0">Hapus Data Secara Massal</h2>
                <div className="flex-grow overflow-auto rounded-lg">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-gray-900 sticky top-0">
                            <tr>
                                <th className="p-3">
                                    <input type="checkbox" onChange={handleSelectAll} checked={records.length > 0 && selectedIds.size === records.length} className="h-4 w-4 rounded bg-gray-700 border-gray-600 text-red-500 focus:ring-red-600" />
                                </th>
                                <th className="p-3 font-semibold text-gray-300">Nama</th>
                                <th className="p-3 font-semibold text-gray-300">Status</th>
                                <th className="p-3 font-semibold text-gray-300">Tanggal Dibuat</th>
                                <th className="p-3 font-semibold text-gray-300">Dibuat Oleh</th>
                            </tr>
                        </thead>
                        <tbody className="bg-gray-800 divide-y divide-gray-700">
                            {records.length > 0 ? records.map(record => (
                                <tr key={record.id} className={`hover:bg-gray-700/50 ${selectedIds.has(record.id) ? 'bg-red-900/30' : ''}`}>
                                    <td className="p-3">
                                        <input type="checkbox" checked={selectedIds.has(record.id)} onChange={() => handleSelectOne(record.id)} className="h-4 w-4 rounded bg-gray-700 border-gray-600 text-red-500 focus:ring-red-600" />
                                    </td>
                                    <td className="p-3 whitespace-nowrap">{record.nama}</td>
                                    <td className="p-3 whitespace-nowrap">{determineDisplayStatus(record)}</td>
                                    <td className="p-3 whitespace-nowrap">{formatFirebaseTimestamp(record.createdAt).date}</td>
                                    <td className="p-3 whitespace-nowrap">{record.createdByName || '-'}</td>
                                </tr>
                            )) : (
                                <tr>
                                    <td colSpan={5} className="text-center p-8 text-gray-400">Tidak ada data untuk rentang tanggal yang dipilih.</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
                <div className="flex justify-between items-center mt-4 flex-shrink-0">
                    <p className="text-sm text-gray-400">{selectedIds.size} data terpilih</p>
                    <div>
                        <button onClick={onClose} className="px-6 py-2 bg-gray-600 text-white font-bold rounded-lg hover:bg-gray-700 mr-3">Tutup</button>
                        <button onClick={handleDelete} disabled={selectedIds.size === 0} className="px-6 py-2 bg-red-600 text-white font-bold rounded-lg hover:bg-red-700 disabled:bg-red-900 disabled:cursor-not-allowed">Hapus Data</button>
                    </div>
                </div>
            </div>
        </div>
    );
};

const TrainerPerformanceListPopup = ({ onClose, performanceData, onSelectTrainer }) => (
    <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-[60] p-4" onClick={onClose}>
        <div className="popup-wrapper popup-wrapper-visible bg-gray-800 p-6 rounded-xl shadow-neumorphic w-full max-w-lg border-2 border-green-500 flex flex-col max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-2xl font-bold text-center text-green-300 mb-4">Laporan Kinerja Pengguna</h2>
            <div className="flex-grow overflow-auto space-y-3 pr-2">
                {performanceData.map(({ trainerName, total, summary }) => (
                    <div key={trainerName} onClick={() => onSelectTrainer(trainerName)} className="bg-gray-900/70 p-4 rounded-lg flex justify-between items-center cursor-pointer hover:bg-gray-700 transition-colors">
                        <div>
                            <h3 className="font-bold text-lg text-white">{trainerName}</h3>
                            <p className="text-xs text-gray-400">{summary}</p>
                        </div>
                        <span className="text-2xl font-bold text-green-400">{total}</span>
                    </div>
                ))}
            </div>
            <div className="mt-4 pt-4 border-t border-gray-700 flex-shrink-0 flex justify-end">
                <button onClick={onClose} className="px-6 py-2 bg-gray-600 text-white font-bold rounded-lg hover:bg-gray-700">Tutup</button>
            </div>
        </div>
    </div>
);

const TrainerWorkDetailPopup = ({ onClose, trainerName, workData }) => (
    <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-[70] p-4" onClick={(e) => e.stopPropagation()}>
        <div className="popup-wrapper popup-wrapper-visible bg-gray-800 p-6 rounded-xl shadow-neumorphic w-full max-w-3xl border-2 border-yellow-500 flex flex-col max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-2xl font-bold text-center text-yellow-300 mb-4">Hasil Kerja: {trainerName}</h2>
            <div className="flex-grow overflow-auto space-y-4 pr-2">
                {Object.entries(workData).map(([branch, records]) => (
                    <div key={branch}>
                        <h3 className="text-lg font-semibold text-white bg-gray-700 px-3 py-2 rounded-t-lg">{branch}</h3>
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 p-3 bg-gray-900/50 rounded-b-lg">
                            {records.map(record => (
                                <div key={record.id} className="bg-black rounded-lg shadow-neumorphic overflow-hidden">
                                    <img src={record.photo || `https://placehold.co/300x200/2d3748/ffffff?text=${record.nama.charAt(0)}`} alt={record.nama} className="w-full h-24 object-cover" />
                                    <div className="p-2 text-xs">
                                        <p className="font-bold text-white truncate">{record.nama}</p>
                                        <p className="text-yellow-400">{determineDisplayStatus(record)}</p>
                                        <p className="text-gray-400">{formatDateString(record.tgl || record.updatedAt?.toDate().toISOString().split('T')[0])}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
            <div className="flex justify-end mt-4">
                <button onClick={onClose} className="px-6 py-2 bg-gray-600 text-white font-bold rounded-lg hover:bg-gray-700">Tutup</button>
            </div>
        </div>
    </div>
);

const FollowUpDateRangePopup = ({ onClose, onFetch }) => {
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');

    return (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 p-4" onClick={onClose}>
            <div className="popup-wrapper popup-wrapper-visible bg-gray-800 p-8 rounded-xl shadow-neumorphic w-full max-w-md space-y-6 border-2 border-green-500" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-2xl font-bold text-center text-green-300">Pilih Rentang Tindak Lanjut</h3>
                <div className="space-y-4">
                    <div>
                        <label className="block mb-2 text-gray-300">Tanggal Mulai</label>
                        <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="w-full input-rounded-border" />
                    </div>
                    <div>
                        <label className="block mb-2 text-gray-300">Tanggal Selesai</label>
                        <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="w-full input-rounded-border" />
                    </div>
                </div>
                <button onClick={() => onFetch(startDate, endDate)} className="w-full px-6 py-3 bg-green-600 text-white font-bold rounded-xl text-lg hover:bg-green-700 shadow-neumorphic">Tampilkan</button>
                <button onClick={onClose} className="w-full mt-2 px-6 py-2 bg-gray-600 text-white font-bold rounded-xl hover:bg-gray-700">Tutup</button>
            </div>
        </div>
    );
};

const FollowUpDetailsPopup = ({ onClose, data }) => {
    const totalPeserta = Object.values(data).reduce((sum, branchData) => {
        return sum + Object.values(branchData).reduce((branchSum, evalList) => branchSum + evalList.length, 0);
    }, 0);

    return (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-[60] p-4" onClick={onClose}>
            <div className="popup-wrapper popup-wrapper-visible bg-gray-800 p-6 rounded-xl shadow-neumorphic w-full max-w-lg border-2 border-indigo-500 flex flex-col max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
                <h2 className="text-2xl font-bold text-center text-indigo-300 mb-2">Rincian Tindak Lanjut Evaluasi</h2>
                <p className="text-center text-gray-400 mb-4">Total Peserta Dievaluasi: {totalPeserta}</p>
                <div className="flex-grow overflow-auto space-y-4 pr-2">
                    {Object.entries(data).map(([cabang, evalTypes]) => (
                        <div key={cabang}>
                            <h3 className="text-lg font-semibold text-white bg-gray-700 px-3 py-2 rounded-t-lg">{cabang} ({Object.values(evalTypes).reduce((acc, list) => acc + list.length, 0)} Peserta)</h3>
                            <div className="bg-gray-900/50 p-3 rounded-b-lg space-y-3">
                                {Object.entries(evalTypes).map(([evalType, participants]) => (
                                    <div key={evalType}>
                                        <h4 className="font-bold text-indigo-300">{evalType}</h4>
                                        <ul className="list-disc list-inside text-sm text-gray-300 pl-2">
                                            {participants.map((p, i) => (
                                                <li key={i}>{p.nama} - dievaluasi oleh {p.evaluator || 'N/A'} pada {p.tanggal}</li>
                                            ))}
                                        </ul>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
                <div className="flex justify-end mt-4">
                    <button onClick={onClose} className="px-6 py-2 bg-gray-600 text-white font-bold rounded-lg hover:bg-gray-700">Tutup</button>
                </div>
            </div>
        </div>
    );
};

const ReportDisplayPopup = ({ onClose, title, columns, startDate, endDate, location }) => {
    const { db, showToast } = useContext(AppContext);
    const [attendanceData, setAttendanceData] = useState([]);
    const [statusChangeData, setStatusChangeData] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [activeFilter, setActiveFilter] = useState('Semua');

    useEffect(() => {
        if (!db || !startDate || !endDate) return;
        setIsLoading(true);

        const start = Timestamp.fromDate(new Date(`${startDate}T00:00:00`));
        const end = Timestamp.fromDate(new Date(`${endDate}T23:59:59`));

        const attendanceQuery = query(collection(db, `artifacts/${appId}/public/data/attendance`), where('date', '>=', start), where('date', '<=', end));
        const unsubAttendance = onSnapshot(attendanceQuery, (snapshot) => {
            const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setAttendanceData(data);
        }, (error) => { console.error("Error fetching attendance:", error); showToast("Gagal memuat data kehadiran."); });

        const recordsQuery = query(collection(db, `artifacts/${appId}/public/data/records`), where('updatedAt', '>=', start), where('updatedAt', '<=', end));
        const unsubRecords = onSnapshot(recordsQuery, (snapshot) => {
            const relevantRecords = snapshot.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(r => r.status === 'Lulus' || r.status === 'Resign');
            setStatusChangeData(relevantRecords);
        }, (error) => { console.error("Error fetching status changes:", error); showToast("Gagal memuat data Lulus/Resign."); });
        
        Promise.all([new Promise(res => onSnapshot(attendanceQuery, res)), new Promise(res => onSnapshot(recordsQuery, res))])
            .then(() => setIsLoading(false));

        return () => { unsubAttendance(); unsubRecords(); };
    }, [db, startDate, endDate, showToast]);
    
    const reportData = useMemo(() => {
        const mappedAttendance = attendanceData.map(d => ({
            id: d.id,
            participantName: d.participantName,
            date: formatFirebaseTimestamp(d.date).date,
            location: d.location,
            status: d.attendanceStatus,
            notes: d.notes || '-',
            recordedBy: d.recordedBy,
        }));

        const mappedStatusChanges = statusChangeData.map(d => ({
            id: d.id,
            participantName: d.nama,
            date: formatFirebaseTimestamp(d.updatedAt).date,
            location: d.turunKeCabang || d.trainganDari || d.cabang,
            status: d.status,
            notes: d.status === 'Lulus' ? `Oleh: ${d.accYangMeluluskan}` : '-',
            recordedBy: d.lastUpdatedByName,
        }));
        
        let combined = [...mappedAttendance, ...mappedStatusChanges];
        if (location && location !== 'semua') {
            combined = combined.filter(item => item.location === location);
        }
        
        combined.sort((a, b) => new Date(b.date) - new Date(a.date));
        return combined;
    }, [attendanceData, statusChangeData, location]);

    const summaryCounts = useMemo(() => {
        return reportData.reduce((acc, row) => {
            const status = row.status || 'N/A';
            acc[status] = (acc[status] || 0) + 1;
            return acc;
        }, {});
    }, [reportData]);
    
    const filterButtons = useMemo(() => {
        const buttonOrder = ['Semua', 'Hadir', 'Izin', 'Sakit', 'Alpa', 'Lulus', 'Resign'];
        return buttonOrder.filter(key => key === 'Semua' || (summaryCounts[key] > 0));
    }, [summaryCounts]);
    
    const filteredData = useMemo(() => {
        if (activeFilter === 'Semua') return reportData;
        return reportData.filter(row => row.status === activeFilter);
    }, [reportData, activeFilter]);

    const getButtonClass = (filter) => {
        const base = "px-3 py-1.5 text-sm font-semibold rounded-lg transition-all";
        const isActive = activeFilter === filter;
        if (isActive) {
            switch (filter) {
                case 'Lulus': return `${base} bg-teal-500 text-white`;
                case 'Resign': return `${base} bg-red-600 text-white`;
                default: return `${base} bg-purple-600 text-white`;
            }
        } else {
             switch (filter) {
                case 'Lulus': return `${base} bg-gray-700 text-teal-300 hover:bg-gray-600`;
                case 'Resign': return `${base} bg-gray-700 text-red-400 hover:bg-gray-600`;
                default: return `${base} bg-gray-700 hover:bg-gray-600`;
            }
        }
    };

    return (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-[70] p-4" onClick={onClose}>
            <div className="popup-wrapper popup-wrapper-visible bg-gray-800 p-6 rounded-xl shadow-neumorphic w-full max-w-7xl border-2 border-purple-500 flex flex-col max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
                <h2 className="text-3xl font-bold text-center text-purple-300 mb-4 flex-shrink-0">{title}</h2>
                <div className="flex flex-wrap gap-2 mb-4 flex-shrink-0">
                    {filterButtons.map(filter => (
                        <button key={filter} onClick={() => setActiveFilter(filter)} className={getButtonClass(filter)}>
                            {filter} <span className="text-xs bg-black/20 px-1.5 py-0.5 rounded-full">{filter === 'Semua' ? reportData.length : summaryCounts[filter] || 0}</span>
                        </button>
                    ))}
                </div>
                <div className="flex-grow overflow-auto rounded-lg">
                    {isLoading ? (<p className="text-center text-gray-400 p-10">Memuat laporan realtime...</p>) : (
                        <table className="w-full text-left text-lg">
                            <thead className="bg-gray-900 sticky top-0"><tr>{columns.map(col => <th key={col.accessor} className="p-4 font-semibold text-gray-100">{col.header}</th>)}</tr></thead>
                            <tbody className="bg-gray-800 divide-y divide-gray-700">
                                {filteredData.length > 0 ? filteredData.map((row) => (
                                    <tr key={row.id} className="hover:bg-gray-700/50">
                                        {columns.map(col => (
                                            <td key={`${row.id}-${col.accessor}`} className={`p-4 whitespace-nowrap text-gray-200 ${col.accessor === 'participantName' ? 'font-bold text-white text-xl' : ''}`}>{row[col.accessor] || '-'}</td>
                                        ))}
                                    </tr>
                                )) : (<tr><td colSpan={columns.length} className="text-center p-8 text-gray-400 text-xl">Tidak ada data untuk filter ini.</td></tr>)}
                            </tbody>
                        </table>
                    )}
                </div>
                <div className="flex justify-end mt-4 flex-shrink-0"><button onClick={onClose} className="px-6 py-2 bg-gray-600 text-white font-bold rounded-lg hover:bg-gray-700">Tutup</button></div>
            </div>
        </div>
    );
};


const ParticipantAttendanceReportDateRangePopup = ({ onClose, onFetch, locations }) => {
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [selectedLocation, setSelectedLocation] = useState('semua');

    return (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-[60] p-4" onClick={onClose}>
            <div className="popup-wrapper popup-wrapper-visible bg-gray-800 p-8 rounded-xl shadow-neumorphic w-full max-w-md space-y-6 border-2 border-blue-500" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-2xl font-bold text-center text-blue-300">Rekapan Daftar Hadir Peserta</h3>
                <div className="space-y-4">
                    <div>
                        <label className="block mb-2 text-gray-300">Tanggal Mulai</label>
                        <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="w-full input-rounded-border" />
                    </div>
                    <div>
                        <label className="block mb-2 text-gray-300">Tanggal Selesai</label>
                        <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="w-full input-rounded-border" />
                    </div>
                    <div>
                        <label className="block mb-2 text-gray-300">Kategori Lokasi TC</label>
                        <select value={selectedLocation} onChange={e => setSelectedLocation(e.target.value)} className="w-full select-rounded-border">
                            <option value="semua">Semua Lokasi</option>
                            {locations.map(loc => <option key={loc} value={loc}>{loc}</option>)}
                        </select>
                    </div>
                </div>
                <button onClick={() => onFetch(startDate, endDate, selectedLocation)} className="w-full px-6 py-3 bg-blue-600 text-white font-bold rounded-xl text-lg hover:bg-blue-700 shadow-neumorphic">Tampilkan</button>
                <button onClick={onClose} className="w-full mt-2 px-6 py-2 bg-gray-600 text-white font-bold rounded-xl hover:bg-gray-700">Tutup</button>
            </div>
        </div>
    );
};

const AttendancePopup = ({ onClose, tcParticipants, athleticParticipants, seitaiParticipants, locations }) => {
    const { db, showToast, currentUser, openModal } = useContext(AppContext);
    const firestore = useFirestore();
    const [activeList, setActiveList] = useState('TC');
    const [selectedLocation, setSelectedLocation] = useState('');
    const [attendanceData, setAttendanceData] = useState({});
    const [participantToResign, setParticipantToResign] = useState(null);
    const [isSaving, setIsSaving] = useState(false);
    
    const attendanceButtonConfigs = [
        { status: 'Hadir', textColor: 'text-green-400', bgColor: 'bg-green-500' },
        { status: 'Izin', textColor: 'text-blue-400', bgColor: 'bg-blue-500' },
        { status: 'Sakit', textColor: 'text-yellow-400', bgColor: 'bg-yellow-500' },
        { status: 'Alpa', textColor: 'text-orange-400', bgColor: 'bg-orange-500' },
    ];
    
    useEffect(() => {
        if (locations.length > 0 && !selectedLocation) {
            setSelectedLocation(locations[0]);
        }
    }, [locations, selectedLocation]);

    const currentParticipants = useMemo(() => {
        switch (activeList) {
            case 'TC':
                return tcParticipants.filter(p => p.trainganDari === selectedLocation);
            case 'Athletic':
                return athleticParticipants;
            case 'Seitai':
                return seitaiParticipants;
            default:
                return [];
        }
    }, [activeList, tcParticipants, athleticParticipants, seitaiParticipants, selectedLocation]);
    
    const handleAttendanceChange = (participantId, status) => {
        setAttendanceData(prev => {
            const currentStatus = prev[participantId]?.status;
            if (currentStatus === status) {
                const newState = { ...prev };
                if (newState[participantId]) {
                    newState[participantId].status = null;
                }
                return newState;
            }
            return { ...prev, [participantId]: { ...prev[participantId], status } };
        });
    };

    const handleNotesChange = (participantId, notes) => {
        setAttendanceData(prev => ({ ...prev, [participantId]: { ...prev[participantId], notes } }));
    };

    const handleResignClick = (participant) => {
        setParticipantToResign(participant);
    };

    const confirmResign = async () => {
        if (!participantToResign) return;
        const resignData = { ...participantToResign, status: 'Resign', tanggalResign: new Date().toISOString().split('T')[0] };
        delete resignData.id;
        await firestore.addOrUpdateRecord(null, resignData);
        setParticipantToResign(null);
    };
    
    const handleSaveAttendance = async () => {
        if (Object.keys(attendanceData).length === 0) {
            showToast("Tidak ada perubahan untuk disimpan.");
            return;
        }
        setIsSaving(true);
        const batch = writeBatch(db);
        const attendanceCollection = collection(db, `artifacts/${appId}/public/data/attendance`);
        
        currentParticipants.forEach(p => {
            const data = attendanceData[p.id];
            if (data && data.status) {
                const newAttendanceRef = doc(attendanceCollection);
                let locationForDb;
                if (activeList === 'TC') {
                    locationForDb = selectedLocation;
                } else if (activeList === 'Athletic') {
                    locationForDb = 'Training Athletic Massage';
                } else if (activeList === 'Seitai') {
                    locationForDb = 'Training Seitai';
                }

                batch.set(newAttendanceRef, {
                    participantId: p.id, participantName: p.nama, location: locationForDb,
                    attendanceStatus: data.status, notes: data.notes || '',
                    date: serverTimestamp(), recordedBy: currentUser.nama
                });
            }
        });

        try {
            await batch.commit();
            showToast("Daftar hadir berhasil disimpan.");
            onClose();
        } catch (error) { 
            showToast("Gagal menyimpan daftar hadir."); 
        } finally {
            setIsSaving(false);
        }
    };
    
    const handleFetchParticipantReport = async (startDate, endDate, location) => {
        if (!startDate || !endDate) {
            showToast("Silakan pilih rentang tanggal yang valid.");
            return;
        }
        openModal('realtimeParticipantAttendanceReport', {
            title: "Rekapan Daftar Hadir & Status Peserta",
            columns: [
                { header: 'Nama', accessor: 'participantName' },
                { header: 'Status', accessor: 'status' },
                { header: 'Tanggal', accessor: 'date' },
                { header: 'Lokasi', accessor: 'location' },
                { header: 'Keterangan', accessor: 'notes' },
                { header: 'Oleh', accessor: 'recordedBy' }
            ],
            startDate, endDate, location
        });
    };

    const attendanceCounts = useMemo(() => {
        return Object.values(attendanceData).reduce((acc, { status }) => {
            if (status) acc[status] = (acc[status] || 0) + 1;
            return acc;
        }, { Hadir: 0, Izin: 0, Sakit: 0, Alpa: 0 });
    }, [attendanceData]);

    const allPossibleLocations = useMemo(() => {
        const specialLocations = [];
        if (athleticParticipants.length > 0) specialLocations.push('Training Athletic Massage');
        if (seitaiParticipants.length > 0) specialLocations.push('Training Seitai');
        return [...locations, ...specialLocations];
    }, [locations, athleticParticipants, seitaiParticipants]);


    return (
        <>
            <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 p-4" onClick={onClose}>
                <div className="popup-wrapper popup-wrapper-visible bg-gray-800 p-6 rounded-xl shadow-neumorphic w-full max-w-2xl border-2 border-green-500 flex flex-col" onClick={(e) => e.stopPropagation()}>
                    <h2 className="text-2xl font-bold text-center text-green-300 mb-4">Daftar Hadir Peserta</h2>
                    
                    <div className="flex border-b border-gray-600 mb-4">
                        <button onClick={() => setActiveList('TC')} className={`flex-1 py-2 text-center font-semibold ${activeList === 'TC' ? 'text-blue-400 border-b-2 border-blue-400' : 'text-gray-400'}`}>TC Reguler</button>
                        <button onClick={() => setActiveList('Athletic')} className={`flex-1 py-2 text-center font-semibold ${activeList === 'Athletic' ? 'text-blue-400 border-b-2 border-blue-400' : 'text-gray-400'}`}>Athletic Massage</button>
                        <button onClick={() => setActiveList('Seitai')} className={`flex-1 py-2 text-center font-semibold ${activeList === 'Seitai' ? 'text-blue-400 border-b-2 border-blue-400' : 'text-gray-400'}`}>Seitai</button>
                    </div>

                    {activeList === 'TC' && (
                        <div className="mb-4">
                            <label className="block mb-2 text-gray-300">Pilih Lokasi TC</label>
                            <select value={selectedLocation} onChange={e => setSelectedLocation(e.target.value)} className="w-full select-rounded-border">
                                {locations.map(loc => <option key={loc} value={loc}>{loc}</option>)}
                            </select>
                        </div>
                    )}

                    <div className="flex-grow overflow-y-auto max-h-[50vh] pr-2 space-y-4">
                        {currentParticipants.length > 0 ? currentParticipants.map((p, index) => (
                            <div key={p.id} className="bg-gray-900 p-4 rounded-lg">
                                <p className="font-bold text-lg text-white mb-2"><span className="text-gray-400 mr-2 text-base">{index + 1}.</span>{p.nama}</p>
                                <div className="flex flex-wrap gap-2 mb-2">
                                    {attendanceButtonConfigs.map(({ status, textColor, bgColor }) => (
                                        <button key={status} onClick={() => handleAttendanceChange(p.id, status)} className={`px-3 py-1 text-sm font-bold rounded-md transition-all ${attendanceData[p.id]?.status === status ? `${bgColor} text-white` : `bg-gray-700 ${textColor} hover:bg-gray-600`}`}>{status}</button>
                                    ))}
                                    <button onClick={() => handleResignClick(p)} className="px-3 py-1 text-sm font-bold rounded-md transition-all bg-gray-700 text-red-400 hover:bg-gray-600">Resign</button>
                                </div>
                                <input type="text" placeholder="Keterangan..." value={attendanceData[p.id]?.notes || ''} onChange={e => handleNotesChange(p.id, e.target.value)} className="w-full input-rounded-border !py-2 !text-sm"/>
                            </div>
                        )) : (
                           <p className="text-center text-gray-400 p-8">Tidak ada peserta aktif di kategori ini.</p>
                        )}
                    </div>
                    <div className="border-t border-gray-600 mt-4 pt-4">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-center mb-4">
                            <p>Hadir: <span className="font-bold text-green-400">{attendanceCounts.Hadir}</span></p>
                            <p>Izin: <span className="font-bold text-blue-400">{attendanceCounts.Izin}</span></p>
                            <p>Sakit: <span className="font-bold text-yellow-400">{attendanceCounts.Sakit}</span></p>
                            <p>Alpa: <span className="font-bold text-orange-400">{attendanceCounts.Alpa}</span></p>
                        </div>
                        <div className="flex flex-col sm:flex-row justify-between items-center gap-3">
                             <button onClick={() => openModal('participantAttendanceReportDateRange', { onFetch: handleFetchParticipantReport, locations: allPossibleLocations })} className="px-6 py-2 bg-gray-700 font-bold rounded-lg hover:bg-gray-600 w-full sm:w-auto">
                                <span className="text-gradient font-bold">Rekapan Peserta</span>
                            </button>
                            <div className="flex gap-3 w-full sm:w-auto">
                                <button onClick={onClose} className="w-full px-6 py-2 bg-gray-600 text-white font-bold rounded-lg hover:bg-gray-700">Tutup</button>
                                <button onClick={handleSaveAttendance} disabled={isSaving} className="w-full px-6 py-2 bg-green-600 text-white font-bold rounded-lg hover:bg-green-700 disabled:bg-green-800 disabled:cursor-not-allowed flex items-center justify-center">
                                    {isSaving ? <SpinnerIcon /> : 'Simpan'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <ConfirmationDialog show={!!participantToResign} onClose={() => setParticipantToResign(null)} onConfirm={confirmResign} title="Konfirmasi Resign" message={`Apakah Anda yakin ingin mengubah status ${participantToResign?.nama} menjadi Resign?`} confirmText="Ya, Resign"/>
        </>
    );
};


// =================================================================================
// KOMPONEN-KOMPONEN YANG SUDAH ADA
// =================================================================================

const AnimateOnScroll = ({ children }) => {
    const ref = useRef(null);
    const [isVisible, setIsVisible] = useState(false);
    useEffect(() => {
        const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) { setIsVisible(true); observer.unobserve(entry.target); }
        }, { threshold: 0.1 });
        const currentRef = ref.current;
        if (currentRef) observer.observe(currentRef);
        return () => { if (currentRef) observer.unobserve(currentRef); };
    }, []);
    return <div ref={ref} className={isVisible ? 'animate-on-scroll' : 'opacity-0'}>{children}</div>;
};

const SuperAdminPopup = ({ onClose, onSuperAdminLogin }) => {
    const [pin, setPin] = useState('');
    const handleSubmit = () => onSuperAdminLogin(pin);

    return (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50" onClick={onClose}>
            <div className="popup-wrapper popup-wrapper-visible bg-gray-800 p-8 rounded-xl shadow-neumorphic w-full max-w-sm space-y-4" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-xl font-bold text-center text-yellow-300">Login Admin Utama</h3>
                <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} className="w-full input-rounded-border" placeholder="Masukkan PIN Admin Utama" onKeyDown={(e) => e.key === 'Enter' && handleSubmit()} />
                <button onClick={handleSubmit} className="w-full px-6 py-3 bg-yellow-500 text-black font-bold rounded-xl text-lg hover:bg-yellow-600 shadow-neumorphic">Login</button>
            </div>
        </div>
    );
};

const LoginScreen = () => {
    const { users, showToast, setCurrentUser, setUserRole, setLoginStep, openModal, closeModal } = useContext(AppContext);
    const [selectedUser, setSelectedUser] = useState('');
    const [pin, setPin] = useState('');

    useEffect(() => {
        if (users.length > 0) {
            const defaultUser = users.find(u => u.nama) || users[0];
            if(defaultUser) setSelectedUser(defaultUser.nama);
        }
    }, [users]);

    const handleLogin = useCallback((selectedUserName, enteredPin) => {
        const user = users.find(u => u.nama === selectedUserName);
        if (user && user.pin === enteredPin) {
            setCurrentUser(user);
            setUserRole(user.role);
            setLoginStep('loggedIn');
            showToast(`Selamat datang, ${user.nama}!`);
        } else {
            showToast("PIN salah. Coba lagi.");
        }
    }, [users, showToast, setCurrentUser, setUserRole, setLoginStep]);

    const handleSuperAdminLogin = useCallback((enteredPin) => {
        if (enteredPin === '197385') {
            const superAdminUser = {
                nama: 'endayshebocah',
                role: 'admin',
                permissions: availablePermissions.reduce((acc, perm) => ({ ...acc, [perm.key]: true }), {})
            };
            setCurrentUser(superAdminUser);
            setUserRole('admin');
            setLoginStep('loggedIn');
            showToast('Selamat datang, Admin Utama!');
            closeModal();
        } else {
            showToast('PIN Admin Utama salah.');
        }
    }, [showToast, setCurrentUser, setUserRole, setLoginStep, closeModal]);

    const handleLoginClick = () => {
        if (!selectedUser || !pin) { showToast("Silakan pilih pengguna dan masukkan PIN."); return; }
        handleLogin(selectedUser, pin);
    };

    return (
        <div className="h-screen w-screen flex items-center justify-center bg-gray-900 p-4">
            <div className="w-full max-w-md p-8 bg-gray-800 rounded-xl shadow-neumorphic border-2 border-purple-500 space-y-6">
                <h1 className="text-3xl font-bold text-center text-blue-300">Login Database</h1>
                {users.length > 0 ? (
                    <>
                        <div className="space-y-4">
                            <div>
                                <label className="block mb-2 text-gray-300 text-base">Pilih Pengguna</label>
                                <select value={selectedUser} onChange={(e) => setSelectedUser(e.target.value)} className="w-full select-rounded-border">
                                    {users.map(user => <option key={user.id} value={user.nama}>{user.nama}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className="block mb-2 text-gray-300 text-base">PIN</label>
                                <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} className="w-full input-rounded-border" placeholder="****" onKeyDown={(e) => e.key === 'Enter' && handleLoginClick()} />
                            </div>
                        </div>
                        <button onClick={handleLoginClick} className="w-full px-6 py-3 bg-blue-500 text-white font-bold rounded-xl text-lg hover:bg-blue-600 shadow-neumorphic">Masuk</button>
                    </>
                ) : (
                    <div className="text-center text-gray-400 p-4 bg-gray-900/50 rounded-lg">
                        <p>Tidak ada pengguna yang terdaftar.</p>
                        <p className="text-sm mt-2">Silakan hubungi administrator untuk membuat akun pertama.</p>
                    </div>
                )}
                <p className="text-center text-xs text-gray-500 cursor-pointer hover:text-yellow-400 transition-colors" onClick={() => openModal('superAdminLogin', { onSuperAdminLogin: handleSuperAdminLogin })}>endayshebocah</p>
            </div>
        </div>
    );
};

const AccessManagementScreen = () => {
    const { users, showToast } = useContext(AppContext);
    const firestore = useFirestore();
    const [isSaving, setIsSaving] = useState(false);
    
    const getInitialFormState = () => ({
        nama: '', pin: '', role: 'trainer', 
        permissions: availablePermissions.reduce((acc, perm) => ({...acc, [perm.key]: !perm.adminOnly}), {})
    });

    const [formData, setFormData] = useState(getInitialFormState());
    const [editingUserId, setEditingUserId] = useState(null);

    const handleFormChange = (e) => {
        const { name, value, type, checked } = e.target;
        if (type === 'checkbox') {
            setFormData(prev => ({ ...prev, permissions: { ...prev.permissions, [name]: checked } }));
        } else {
            setFormData(prev => ({ ...prev, [name]: value }));
        }
    };
    
    const resetForm = () => {
        setFormData(getInitialFormState());
        setEditingUserId(null);
    };

    const handleEditClick = (user) => {
        setFormData({
            nama: user.nama || '', pin: user.pin || '', role: user.role || 'trainer',
            permissions: user.permissions || getInitialFormState().permissions
        });
        setEditingUserId(user.id);
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!formData.nama || !formData.pin) {
            showToast("Nama dan PIN harus diisi.");
            return;
        }
        setIsSaving(true);
        try {
            const success = await firestore.addOrUpdateUser(editingUserId, formData);
            if (success) resetForm();
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="p-4 md:p-6 space-y-6">
            <div className="bg-gray-800 rounded-xl shadow-neumorphic border-2 border-teal-500 p-6 max-w-4xl mx-auto">
                <h2 className="text-2xl font-bold text-teal-300 mb-4">{editingUserId ? 'Edit Pengguna' : 'Tambah Pengguna Baru'}</h2>
                <form onSubmit={handleSubmit} className="space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <input type="text" name="nama" placeholder="Nama Pengguna" value={formData.nama} onChange={handleFormChange} className="input-rounded-border" required />
                        <input type="text" name="pin" placeholder="PIN" value={formData.pin} onChange={handleFormChange} className="input-rounded-border" required />
                        <select name="role" value={formData.role} onChange={handleFormChange} className="select-rounded-border">
                            <option value="trainer">Trainer</option>
                            <option value="admin">Admin</option>
                        </select>
                    </div>
                    <div>
                        <h3 className="text-lg font-semibold text-gray-300 mb-3">Izin Akses Menu</h3>
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                            {availablePermissions.map(perm => (
                                <label key={perm.key} className="flex items-center space-x-3 p-2 bg-gray-900/50 rounded-lg">
                                    <input type="checkbox" name={perm.key} checked={!!formData.permissions[perm.key]} onChange={handleFormChange} className="h-5 w-5 rounded bg-gray-700 border-gray-600 text-blue-500 focus:ring-blue-600"/>
                                    <span className="text-sm">{perm.label}</span>
                                </label>
                            ))}
                        </div>
                    </div>
                    <div className="flex justify-end gap-3 pt-4">
                        {editingUserId && <button type="button" onClick={resetForm} className="px-4 py-2 bg-gray-600 text-white font-semibold rounded-lg hover:bg-gray-700">Batal</button>}
                        <button type="submit" disabled={isSaving} className="px-4 py-2 bg-teal-600 text-white font-semibold rounded-lg hover:bg-teal-700 disabled:bg-teal-800 disabled:cursor-not-allowed flex items-center justify-center w-48">
                           {isSaving ? <SpinnerIcon /> : (editingUserId ? 'Simpan Perubahan' : 'Tambah Pengguna')}
                        </button>
                    </div>
                </form>
            </div>
            <div className="bg-gray-800 rounded-xl shadow-neumorphic border-2 border-teal-500 p-6 max-w-4xl mx-auto">
                <h2 className="text-2xl font-bold text-teal-300 mb-4">Daftar Pengguna</h2>
                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <thead className="border-b border-gray-600">
                            <tr>
                                <th className="p-3">Nama</th><th className="p-3">Peran</th>
                                <th className="p-3">Izin Diberikan</th><th className="p-3 text-right">Aksi</th>
                            </tr>
                        </thead>
                        <tbody>
                            {users.map(user => (
                                <tr key={user.id} className="border-b border-gray-700">
                                    <td className="p-3 align-top">{user.nama}</td>
                                    <td className="p-3 align-top capitalize">{user.role}</td>
                                    <td className="p-3 align-top">
                                        <div className="flex flex-wrap gap-1">
                                            {availablePermissions.filter(perm => user.permissions && user.permissions[perm.key]).map(perm => (
                                                <span key={perm.key} className="text-xs bg-blue-900/70 text-blue-200 px-2 py-1 rounded-full">{perm.label}</span>
                                            ))}
                                        </div>
                                    </td>
                                    <td className="p-3 flex justify-end gap-2 align-top">
                                        <button onClick={() => handleEditClick(user)} className="p-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"><svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path d="M17.414 2.586a2 2 0 00-2.828 0L7 10.172V13h2.828l7.586-7.586a2 2 0 000-2.828z" /><path fillRule="evenodd" d="M2 6a2 2 0 012-2h4a1 1 0 010 2H4v10h10v-4a1 1 0 112 0v4a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" clipRule="evenodd" /></svg></button>
                                        <button onClick={() => firestore.deleteUser(user.id, user.nama)} className="p-2 bg-red-600 text-white rounded-md hover:bg-red-700"><svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 012 0v6a1 1 0 11-2 0V8z" clipRule="evenodd" /></svg></button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};

const EvaluationScheduleScreen = ({ latestRecords, allRecords, onEdit, onDelete, onUpdateLatest }) => {
    const [evaluationCategoryFilter, setEvaluationCategoryFilter] = useState('semua');
    const [expandedDetail, setExpandedDetail] = useState(null);
    const evaluationCategories = ["Evaluasi Reflexology", "Evaluasi Athletic Massage", "Evaluasi Seitai"];
    const colors = useMemo(() => ['border-indigo-500', 'border-purple-500', 'border-teal-500', 'border-pink-500', 'border-sky-500'], []);

    const handleCardClick = (record) => {
        if (expandedDetail && expandedDetail.id === record.id) {
            setExpandedDetail(null);
        } else {
            setExpandedDetail(record);
        }
    };

    const dueParticipants = useMemo(() => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const dueList = latestRecords.filter(record => {
            const isEvaluation = evaluationCategories.some(cat => record.status.includes(cat));
            const isLulusFromCeking = record.status === 'Lulus';
            
            if (!isEvaluation && !isLulusFromCeking) return false;
            
            let lastDateStr = record.tgl || record.tanggalLulus;
            if (!lastDateStr) return false;
            
            const lastDate = new Date(`${lastDateStr}T00:00:00Z`);
            if (isNaN(lastDate.getTime())) return false;
            
            const dueDate = new Date(lastDate);
            dueDate.setMonth(dueDate.getMonth() + 3);
            
            return dueDate <= today;
        });

        if (evaluationCategoryFilter !== 'semua') {
            return dueList.filter(record => {
                if (record.status === 'Lulus' && evaluationCategoryFilter === 'Evaluasi Reflexology') return true;
                return record.status === evaluationCategoryFilter;
            });
        }
        return dueList;

    }, [latestRecords, evaluationCategoryFilter]);

    const participantsByBranch = useMemo(() => {
        return dueParticipants.reduce((acc, record) => {
            const branch = record.turunKeCabang || record.cabang || 'Belum Ditentukan';
            if (!acc[branch]) acc[branch] = [];
            acc[branch].push(record);
            return acc;
        }, {});
    }, [dueParticipants]);

    const sortedBranches = useMemo(() => {
        return Object.entries(participantsByBranch).sort(([, a], [, b]) => b.length - a.length);
    }, [participantsByBranch]);

    return (
        <div className="p-4 md:p-8 space-y-8">
            <div className="flex flex-col sm:flex-row justify-between items-center gap-4">
                <h2 className="text-2xl md:text-3xl font-bold text-purple-300 text-center sm:text-left">Jadwal Evaluasi</h2>
                <select 
                    value={evaluationCategoryFilter} 
                    onChange={e => setEvaluationCategoryFilter(e.target.value)} 
                    className="select-rounded-border !py-2 !px-3 !text-sm w-full sm:w-auto"
                >
                    <option value="semua">Semua Kategori</option>
                    {evaluationCategories.map(cat => <option key={cat} value={cat}>{cat.replace('Evaluasi ', '')}</option>)}
                </select>
            </div>
            {sortedBranches.length === 0 ? (
                <div className="text-center text-gray-400 mt-10 text-xl">Tidak ada jadwal evaluasi yang jatuh tempo untuk filter ini.</div>
            ) : (
                sortedBranches.map(([branch, participants], index) => (
                    <AnimateOnScroll key={branch}>
                        <div className={`bg-gray-800 rounded-xl shadow-neumorphic border-2 ${colors[index % colors.length]} p-4 sm:p-6 space-y-4`}>
                            <h3 className="text-xl font-semibold text-white">{branch}</h3>
                            <div className="flex overflow-x-auto gap-4 p-2 bg-gray-900/50 rounded-lg horizontal-scroll-container">
                               {participants.map(record => (
                                    <EvaluationCard key={record.id} record={record} onFollowUp={onEdit} onCardClick={handleCardClick} />
                                ))}
                            </div>
                            {expandedDetail && participants.some(p => p.id === expandedDetail.id) && (
                                <div className="w-full">
                                    <ParticipantDetailView
                                        participant={expandedDetail}
                                        allRecords={allRecords}
                                        onClose={() => setExpandedDetail(null)}
                                        onEdit={onEdit}
                                        onDelete={onDelete}
                                        onUpdateLatest={onUpdateLatest}
                                    />
                                </div>
                            )}
                        </div>
                    </AnimateOnScroll>
                ))
            )}
        </div>
    );
};

const TrashScreen = ({ deletedRecords, onRestore, onDeletePermanent }) => {
    const handleDeleteClick = (id, name) => {
        onDeletePermanent(id, name);
    };

    return (
        <div className="p-4 md:p-8">
            <div className="bg-gray-800 rounded-xl shadow-neumorphic border-2 border-red-500 p-6">
                <h2 className="text-2xl font-bold text-red-300 mb-4">Tong Sampah</h2>
                {deletedRecords.length === 0 ? (
                    <p className="text-gray-400">Tong sampah kosong.</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left">
                            <thead className="border-b border-gray-600"><tr><th className="p-3">Nama</th><th className="p-3 hidden sm:table-cell">Status Terakhir</th><th className="p-3 text-right">Aksi</th></tr></thead>
                            <tbody>
                                {deletedRecords.map(record => (
                                    <tr key={record.id} className="border-b border-gray-700">
                                        <td className="p-3">{record.nama}</td><td className="p-3 hidden sm:table-cell">{record.status}</td>
                                        <td className="p-3 flex justify-end gap-2">
                                            <button onClick={() => handleDeleteClick(record.id, record.nama)} className="p-2 bg-red-600 text-white rounded-md hover:bg-red-700">Hapus</button>
                                            <button onClick={() => onRestore(record.id)} className="p-2 bg-green-600 text-white rounded-md hover:bg-green-700">Pulihkan</button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
};

const AssessmentPopup = ({ onSave, onClose, initialData, evaluationStatus }) => {
    const [showConfirmation, setShowConfirmation] = useState(false);
    const [assessmentData, setAssessmentData] = useState({
        ratings: {}, manualNotes: {}, finalNote: ''
    });

    useEffect(() => {
        setAssessmentData({
            ratings: initialData?.ratings || { ketepatanWaktu: '', bagianKaki: '', bagianTangan: '', bagianPunggung: '', bagianPundak: '' },
            manualNotes: initialData?.manualNotes || { ketepatanWaktu: '', bagianKaki: '', bagianTangan: '', bagianPunggung: '', bagianPundak: '' },
            finalNote: initialData?.catatan || ''
        });
    }, [initialData]);

    const isSeitai = evaluationStatus === 'Evaluasi Seitai' || evaluationStatus === 'Ceking Seitai';
    const assessmentCategories = [
        { key: 'ketepatanWaktu', label: isSeitai ? 'Attitude' : 'Ketepatan Waktu (Durasi Sesi)' },
        { key: 'bagianKaki', label: isSeitai ? 'Face Down' : 'Bagian Kaki' },
        { key: 'bagianTangan', label: isSeitai ? 'Face Up' : 'Bagian Tangan' },
        { key: 'bagianPunggung', label: isSeitai ? 'Side Lying' : 'Bagian Punggung' },
        { key: 'bagianPundak', label: isSeitai ? 'Adjustment' : 'Bagian Pundak & Kepala' }
    ];
    const ratingOptions = ['Kurang', 'Cukup', 'Baik'];

    const handleRatingChange = (categoryKey, rating) => {
        setAssessmentData(prev => ({ ...prev, ratings: { ...prev.ratings, [categoryKey]: rating } }));
    };

    const handleManualNoteChange = (categoryKey, note) => {
        setAssessmentData(prev => ({ ...prev, manualNotes: { ...prev.manualNotes, [categoryKey]: note } }));
    };

    const handleFinalNoteChange = (e) => {
        setAssessmentData(prev => ({ ...prev, finalNote: e.target.value }));
    };

    const triggerSaveConfirmation = () => {
        setShowConfirmation(true);
    };

    const confirmAndSave = () => {
        const dataToSave = {
            ratings: assessmentData.ratings,
            manualNotes: assessmentData.manualNotes,
            catatan: assessmentData.finalNote
        };
        onSave(dataToSave);
        setShowConfirmation(false);
        onClose();
    };

    return (
        <>
            <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 p-4" onClick={onClose}>
                <div className="popup-wrapper popup-wrapper-visible bg-gray-800 p-6 rounded-xl shadow-neumorphic w-full max-w-lg border-2 border-purple-500 flex flex-col max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
                    <h3 className="text-xl font-bold text-center text-purple-300 mb-4 flex-shrink-0">Formulir Penilaian Cepat</h3>
                    <div className="flex-grow overflow-y-auto space-y-4 pr-2">
                        {assessmentCategories.map(cat => (
                            <div key={cat.key} className="bg-gray-900/70 p-4 rounded-lg">
                                <label className="font-semibold text-white mb-2 block">{cat.label}</label>
                                <div className="flex flex-wrap gap-2 mb-2">
                                    {ratingOptions.map(opt => (
                                        <button key={opt} onClick={() => handleRatingChange(cat.key, opt)} className={`px-4 py-1.5 text-sm font-semibold rounded-md transition-all flex-grow ${assessmentData.ratings[cat.key] === opt ? 'text-white ' + (opt === 'Baik' ? 'bg-green-500' : opt === 'Cukup' ? 'bg-yellow-500' : 'bg-red-500') : 'bg-gray-600 text-gray-300 hover:bg-gray-500'}`}>{opt}</button>
                                    ))}
                                </div>
                                <input type="text" value={assessmentData.manualNotes[cat.key] || ''} onChange={(e) => handleManualNoteChange(cat.key, e.target.value)} placeholder="Tambah catatan spesifik (opsional)..." className="w-full input-rounded-border !py-2 !text-sm"/>
                            </div>
                        ))}
                    </div>
                    <div className="mt-4 pt-4 border-t border-gray-700 flex-shrink-0">
                        <label className="block mb-2 font-semibold text-white">Catatan / Ulasan Akhir (Opsional)</label>
                        <textarea name="catatan" value={assessmentData.finalNote || ''} onChange={handleFinalNoteChange} placeholder="Ulasan umum bisa diisi manual di sini..." className="w-full textarea-rounded-border h-24"></textarea>
                        <div className="flex justify-end gap-3 mt-3">
                            <button onClick={onClose} className="px-4 py-2 bg-gray-600 text-white font-semibold rounded-lg hover:bg-gray-700">Batal</button>
                            <button onClick={triggerSaveConfirmation} className="px-4 py-2 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700">Simpan Penilaian</button>
                        </div>
                    </div>
                </div>
            </div>

            <ConfirmationDialog
                show={showConfirmation}
                onClose={() => setShowConfirmation(false)}
                onConfirm={confirmAndSave}
                title="Konfirmasi Simpan"
                message="Apakah Anda yakin ingin menyimpan penilaian ini? Data akan disimpan sementara dan diterapkan saat Anda menyimpan formulir utama."
                confirmText="Ya, Simpan"
            />
        </>
    );
};

// =================================================================================
// KOMPONEN FORM SPESIFIK (HASIL REFAKTORISASI)
// =================================================================================

const TrainingReflexAthleticForm = ({ formValues, handleFormInputChange, trainingDariList }) => (
    <>
        <div><label className="block mb-2 text-gray-300 text-base">Kota Asal</label><input type="text" name="kotaAsal" value={formValues.kotaAsal || ''} onChange={handleFormInputChange} className="w-full input-rounded-border" /></div>
        <div><label className="block mb-2 text-gray-300 text-base">Tanggal Masuk</label><input type="date" name="tanggalMasuk" value={formValues.tanggalMasuk || ''} onChange={handleFormInputChange} className="w-full input-rounded-border" /></div>
        <div><label className="block mb-2 text-gray-300 text-base">Refrensi</label><input type="text" name="refrensi" value={formValues.refrensi || ''} onChange={handleFormInputChange} className="w-full input-rounded-border" /></div>
        <div><label className="block mb-2 text-gray-300 text-base">Training Dari</label><select name="trainganDari" value={formValues.trainganDari || ''} onChange={handleFormInputChange} className="w-full select-rounded-border"><option value="">Pilih Lokasi</option>{trainingDariList.map(loc => <option key={loc} value={loc}>{loc}</option>)}</select></div>
    </>
);

const TrainingSeitaiForm = ({ formValues, handleFormInputChange, branchList, trainingDariList }) => (
    <>
        <div>
            <label className="block mb-2 text-gray-300 text-base">Cabang</label>
            <select name="cabang" value={formValues.cabang || ''} onChange={handleFormInputChange} className="w-full select-rounded-border">
                <option value="">Pilih Cabang</option>
                {branchList.map(branch => <option key={branch} value={branch}>{branch}</option>)}
            </select>
        </div>
        <div><label className="block mb-2 text-gray-300 text-base">Tanggal Masuk</label><input type="date" name="tanggalMasuk" value={formValues.tanggalMasuk || ''} onChange={handleFormInputChange} className="w-full input-rounded-border" /></div>
        <div><label className="block mb-2 text-gray-300 text-base">Lokasi Dari</label><select name="trainganDari" value={formValues.trainganDari || ''} onChange={handleFormInputChange} className="w-full select-rounded-border"><option value="">Pilih Lokasi</option>{trainingDariList.map(loc => <option key={loc} value={loc}>{loc}</option>)}</select></div>
    </>
);

const CekingForm = ({ formValues, setFormValues, handleFormInputChange, onOpenAssessment, activeRecords, branchList, trainingDariList }) => {

    useEffect(() => {
        if (formValues.nama) {
            const nextStage = getNextCekingStage(formValues.nama, activeRecords);
            if (formValues.tahapCeking !== nextStage) {
                setFormValues(prev => ({ ...prev, tahapCeking: nextStage }));
            }
        }
    }, [formValues.nama, activeRecords, setFormValues, formValues.tahapCeking]);
    
    const handleCekingTypeClick = (type) => {
        setFormValues(prev => ({ ...prev, cekingType: type }));
    };

    return (
        <>
            <div><label className="block mb-2 text-gray-300 text-base">Trainer</label><input type="text" name="trainer" value={formValues.trainer || ''} className="w-full input-rounded-border bg-gray-700 cursor-not-allowed" readOnly /></div>
            <div><label className="block mb-2 text-gray-300 text-base">Tahap Ceking</label><input type="text" name="tahapCeking" value={formValues.tahapCeking || ''} readOnly className="w-full input-rounded-border bg-gray-700 cursor-not-allowed"/></div>
            <div className="sm:col-span-2">
                <div className="flex flex-col sm:flex-row gap-2">
                    <button type="button" onClick={() => handleCekingTypeClick('Reflexology')} className={`w-full py-2 rounded-lg font-semibold ${formValues.cekingType === 'Reflexology' || !formValues.cekingType ? 'bg-indigo-600 text-white' : 'bg-gray-600'}`}>Reflexology</button>
                    <button type="button" onClick={() => handleCekingTypeClick('Athletic Massage')} className={`w-full py-2 rounded-lg font-semibold ${formValues.cekingType === 'Athletic Massage' ? 'bg-indigo-600 text-white' : 'bg-gray-600'}`}>Athletic Massage</button>
                    <button type="button" onClick={() => handleCekingTypeClick('Seitai')} className={`w-full py-2 rounded-lg font-semibold ${formValues.cekingType === 'Seitai' ? 'bg-indigo-600 text-white' : 'bg-gray-600'}`}>Seitai</button>
                </div>
            </div>
            <div><label className="block mb-2 text-gray-300 text-base">Tanggal</label><input type="date" name="tgl" value={formValues.tgl || ''} onChange={handleFormInputChange} className="w-full input-rounded-border" /></div>
            {formValues.cekingResult !== 'Lulus' && <div><label className="block mb-2 text-gray-300 text-base">Training Dari</label><select name="trainganDari" value={formValues.trainganDari || ''} onChange={handleFormInputChange} className="w-full select-rounded-border"><option value="">Pilih Lokasi</option>{trainingDariList.map(loc => <option key={loc} value={loc}>{loc}</option>)}</select></div>}
            {formValues.cekingResult === 'Lulus' && <div><label className="block mb-2 text-gray-300 text-base">Tanggal Lulus</label><input type="date" name="tanggalLulus" value={formValues.tanggalLulus || ''} onChange={handleFormInputChange} className="w-full input-rounded-border" /></div>}
            <div className="sm:col-span-2"><label className="block mb-2 text-gray-300 text-base">Hasil Ceking</label><div className="flex gap-2"><button type="button" onClick={() => handleFormInputChange({ target: { name: 'cekingResult', value: 'Masih Tahap Ceking' }})} className={`w-full py-2 rounded-lg font-semibold ${formValues.cekingResult === 'Masih Tahap Ceking' || !formValues.cekingResult ? 'bg-blue-600 text-white' : 'bg-gray-600'}`}>Masih Tahap Ceking</button><button type="button" onClick={() => handleFormInputChange({ target: { name: 'cekingResult', value: 'Lulus' }})} className={`w-full py-2 rounded-lg font-semibold ${formValues.cekingResult === 'Lulus' ? 'bg-green-600 text-white' : 'bg-gray-600'}`}>Lulus</button></div></div>
            <div className="sm:col-span-2">
                <button type="button" onClick={onOpenAssessment} disabled={!formValues.nama} className="w-full px-4 py-3 bg-purple-600 text-white font-semibold rounded-lg hover:bg-purple-700 shadow-neumorphic disabled:bg-gray-700 disabled:cursor-not-allowed">
                    Buka & Isi Formulir Penilaian
                </button>
            </div>
            {formValues.cekingResult === 'Lulus' && (<>
                <div>
                    <label className="block mb-2 text-gray-300 text-base">Cabang</label>
                    <select name="turunKeCabang" value={formValues.turunKeCabang || ''} onChange={handleFormInputChange} className="w-full select-rounded-border">
                        <option value="">Pilih Cabang</option>
                        {branchList.map(branch => <option key={branch} value={branch}>{branch}</option>)}
                    </select>
                </div>
                <div><label className="block mb-2 text-gray-300 text-base">Acc Yang Meluluskan</label><input type="text" name="accYangMeluluskan" value={formValues.accYangMeluluskan || ''} onChange={handleFormInputChange} className="w-full input-rounded-border" /></div>
            </>)}
        </>
    );
};

const EvaluasiForm = ({ formValues, handleFormInputChange, onOpenAssessment, activeRecords, branchList }) => {
    const { userRole } = useContext(AppContext);
    const lastCekingStage = useMemo(() => getNextCekingStage(formValues.nama, activeRecords), [formValues.nama, activeRecords]);
    const evaluationCategory = formValues.status.replace('Evaluasi ', '');

    return (
        <>
            <div><label className="block mb-2 text-gray-300 text-base">Trainer</label><input type="text" name="trainer" value={formValues.trainer || ''} className="w-full input-rounded-border bg-gray-700 cursor-not-allowed" readOnly /></div>
            <div><label className="block mb-2 text-gray-300 text-base">Tahap Ceking</label><input type="text" name="tahapCeking" value={formValues.tahapCeking || ''} onChange={handleFormInputChange} readOnly={userRole !== 'admin'} className={`w-full input-rounded-border ${userRole !== 'admin' ? 'bg-gray-700 cursor-not-allowed' : ''}`} placeholder={lastCekingStage}/></div>
            <div>
                <label className="block mb-2 text-gray-300 text-base">Cabang</label>
                <select name="cabang" value={formValues.cabang || ''} onChange={handleFormInputChange} className="w-full select-rounded-border">
                    <option value="">Pilih Cabang</option>
                    {branchList.map(branch => <option key={branch} value={branch}>{branch}</option>)}
                </select>
            </div>
            <div><label className="block mb-2 text-gray-300 text-base">Tanggal Evaluasi</label><input type="date" name="tgl" value={formValues.tgl || ''} onChange={handleFormInputChange} className="w-full input-rounded-border" /></div>
            <div className="sm:col-span-2">
                <label className="block mb-2 text-gray-300 text-base">Hasil Evaluasi</label>
                <div className="flex gap-2">
                    <button type="button" onClick={() => handleFormInputChange({ target: { name: 'evaluationResult', value: 'Masih Tahap Evaluasi' }})} className={`w-full py-2 rounded-lg font-semibold ${formValues.evaluationResult === 'Masih Tahap Evaluasi' || !formValues.evaluationResult ? 'bg-purple-600 text-white' : 'bg-gray-600'}`}>{`Masih Tahap ${evaluationCategory}`}</button>
                    <button type="button" onClick={() => handleFormInputChange({ target: { name: 'evaluationResult', value: 'Lulus' }})} className={`w-full py-2 rounded-lg font-semibold ${formValues.evaluationResult === 'Lulus' ? 'bg-green-600 text-white' : 'bg-gray-600'}`}>{`Lulus ${evaluationCategory}`}</button>
                </div>
            </div>
            <div className="sm:col-span-2">
                <button type="button" onClick={onOpenAssessment} disabled={!formValues.nama} className="w-full px-4 py-3 bg-purple-600 text-white font-semibold rounded-lg hover:bg-purple-700 shadow-neumorphic disabled:bg-gray-700 disabled:cursor-not-allowed">
                    Buka & Isi Formulir Penilaian
                </button>
            </div>
            {formValues.evaluationResult === 'Lulus' && (
                <>
                    <div><label className="block mb-2 text-gray-300 text-base">Tanggal Lulus Evaluasi</label><input type="date" name="tanggalLulus" value={formValues.tanggalLulus || ''} onChange={handleFormInputChange} className="w-full input-rounded-border" /></div>
                    <div><label className="block mb-2 text-gray-300 text-base">Acc Yang Meluluskan</label><input type="text" name="accYangMeluluskan" value={formValues.accYangMeluluskan || ''} onChange={handleFormInputChange} className="w-full input-rounded-border" /></div>
                </>
            )}
        </>
    );
};

const ResignForm = ({ formValues, handleFormInputChange, trainingDariList }) => (
    <>
        <div><label className="block mb-2 text-gray-300 text-base">Kota Asal</label><input type="text" name="kotaAsal" value={formValues.kotaAsal || ''} onChange={handleFormInputChange} className="w-full input-rounded-border" /></div>
        <div><label className="block mb-2 text-gray-300 text-base">Tanggal Masuk</label><input type="date" name="tanggalMasuk" value={formValues.tanggalMasuk || ''} onChange={handleFormInputChange} className="w-full input-rounded-border" /></div>
        <div><label className="block mb-2 text-gray-300 text-base">Tanggal Resign</label><input type="date" name="tanggalResign" value={formValues.tanggalResign || ''} onChange={handleFormInputChange} className="w-full input-rounded-border" /></div>
        <div><label className="block mb-2 text-gray-300 text-base">Refrensi</label><input type="text" name="refrensi" value={formValues.refrensi || ''} onChange={handleFormInputChange} className="w-full input-rounded-border" /></div>
        <div className="sm:col-span-2"><label className="block mb-2 text-gray-300 text-base">Training Dari</label><select name="trainganDari" value={formValues.trainganDari || ''} onChange={handleFormInputChange} className="w-full select-rounded-border"><option value="">Pilih Lokasi</option>{trainingDariList.map(loc => <option key={loc} value={loc}>{loc}</option>)}</select></div>
    </>
);


const DynamicForm = ({
    isFormExpanded, formValues, setFormValues, handleFormInputChange, handleAddOrUpdateRecord, resetForm,
    fileInputRef, handleFileSelect, activeRecords, handleSuggestionClick, nameSuggestions, 
    setNameSuggestions, onOpenAssessment, isSpecialTrainingPath, branchList, trainingDariList, isSaving
}) => {
    
    const renderFormContent = () => {
        const { status } = formValues;
        const formProps = { formValues, setFormValues, handleFormInputChange, onOpenAssessment, activeRecords, branchList, trainingDariList };
        
        if (status.startsWith('Training') && status !== 'Training Seitai') return <TrainingReflexAthleticForm {...formProps} />;
        if (status === 'Training Seitai') return <TrainingSeitaiForm {...formProps} />;
        if (status === 'Tahap Ceking') return <CekingForm {...formProps} />;
        if (status.startsWith('Evaluasi')) return <EvaluasiForm {...formProps} />;
        if (status === 'Resign' || status === 'Ganti Peserta') return <ResignForm {...formProps} />;
        return null;
    };

    return (
        <div className={`details-section ${isFormExpanded ? 'p-4 sm:p-8' : 'details-section-hidden'}`}>
             <form onSubmit={handleAddOrUpdateRecord} className="space-y-6">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
                    <div className="sm:col-span-2 relative">
                        <label className="block mb-2 text-gray-300 text-base">Nama</label>
                        <input type="text" name="nama" value={formValues.nama || ''} onChange={handleFormInputChange} onBlur={() => setTimeout(() => setNameSuggestions([]), 150)} required className="w-full input-rounded-border" autoComplete="off"/>
                        {nameSuggestions.length > 0 && formValues.nama.length > 0 && (
                            <ul className="absolute z-20 w-full bg-gray-700 border border-gray-600 rounded-md mt-1 max-h-48 overflow-y-auto shadow-lg">
                                {nameSuggestions.map(suggestion => (
                                    <li key={suggestion.id} className="px-4 py-2 cursor-pointer hover:bg-gray-600 text-white" onMouseDown={() => handleSuggestionClick(suggestion)}>{suggestion.nama}</li>
                                ))}
                            </ul>
                        )}
                    </div>
                    <div className="sm:col-span-2">
                        <label className="block mb-2 text-gray-300 text-base">Status</label>
                        <select name="status" value={formValues.status || 'Training Reflexology'} onChange={handleFormInputChange} className="w-full select-rounded-border">
                            <option value="Training Reflexology">Training Reflexology</option>
                            <option value="Training Athletic Massage">Training Athletic Massage</option>
                            <option value="Training Seitai">Training Seitai</option>
                            <option value="Tahap Ceking">Tahap Ceking</option>
                            <option value="Evaluasi Reflexology">Evaluasi Reflexology</option>
                            <option value="Evaluasi Athletic Massage">Evaluasi Athletic Massage</option>
                            <option value="Evaluasi Seitai">Evaluasi Seitai</option>
                            <option value="Resign">Resign</option>
                            {isSpecialTrainingPath && <option value="Ganti Peserta">Ganti Peserta</option>}
                        </select>
                    </div>
                    {renderFormContent()}
                </div>
                <div className="flex flex-col sm:flex-row flex-wrap justify-between items-center pt-4 gap-4">
                    <div className="flex items-center gap-4">
                        <button type="button" onClick={() => fileInputRef.current.click()} className="px-4 py-2 bg-indigo-500 text-white font-semibold rounded-lg hover:bg-indigo-600 shadow-neumorphic">Unggah Foto</button>
                        {formValues.photo && <img src={formValues.photo} alt="Preview" className="h-16 w-16 rounded-lg object-cover border-2 border-blue-400"/>}
                        <input type="file" ref={fileInputRef} onChange={handleFileSelect} accept="image/*" className="hidden" />
                    </div>
                    <div className="flex items-center gap-4 justify-end">
                        <button type="button" onClick={resetForm} className="px-6 py-3 bg-red-500 text-white font-bold rounded-xl text-base hover:bg-red-600 shadow-neumorphic">Batal</button>
                        <button type="submit" disabled={isSaving} className="px-6 py-3 bg-blue-500 text-white font-bold rounded-xl text-base hover:bg-blue-600 shadow-neumorphic disabled:bg-blue-800 disabled:cursor-not-allowed flex items-center justify-center w-28">
                             {isSaving ? <SpinnerIcon /> : 'Simpan'}
                        </button>
                    </div>
                </div>
             </form>
        </div>
    );
};


// =================================================================================
// LAYAR-LAYAR UTAMA (HASIL REFAKTORISASI)
// =================================================================================
const ParticipantGroup = ({ name, participants, allRecords, onEdit, onDelete, onUpdateLatest, colors, index, expandedDetail, handleCardClick }) => {
    const [statusFilter, setStatusFilter] = useState('semua');

    const summary = useMemo(() => {
        const s = {
            training: participants.filter(r => r.status.startsWith('Training')).length,
            ceking: participants.filter(r => determineDisplayStatus(r) === 'Tahap Ceking').length,
            resign: participants.filter(r => r.status === 'Resign').length,
            gantiPeserta: participants.filter(r => r.status === 'Ganti Peserta').length,
        };
        s.semua = s.training + s.ceking;
        return s;
    }, [participants]);

    const filterOptions = useMemo(() => {
        const isSpecialTrainingGroup = name === 'Trainingan Seitai' || name === 'Trainingan Athletic Massage';
        const options = [
            { value: "semua", label: `Tampilkan Semua (${summary.semua})` },
            { value: "Trainingan", label: `Training (${summary.training})`, count: summary.training },
            { value: "Ceking", label: `Ceking (${summary.ceking})`, count: summary.ceking },
        ];
        if (isSpecialTrainingGroup) {
            options.push({ value: "Ganti Peserta", label: `Ganti Peserta (${summary.gantiPeserta})`, count: summary.gantiPeserta });
        } else {
            options.push({ value: "Resign", label: `Resign (${summary.resign})`, count: summary.resign });
        }
        return options.filter(opt => opt.value === 'semua' || opt.count > 0);
    }, [name, summary]);

    return (
        <AnimateOnScroll>
            <div className={`bg-gray-800 rounded-xl shadow-neumorphic border-2 ${colors[index % colors.length]} p-4 sm:p-6 space-y-4`}>
                <div className="flex flex-col sm:flex-row justify-between items-center gap-4">
                    <h2 className="text-xl sm:text-2xl md:text-3xl font-bold text-white text-center sm:text-left">{name}</h2>
                    <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} onClick={(e) => e.stopPropagation()} className="select-rounded-border !py-2 !px-3 !text-sm w-full sm:w-56">
                        {filterOptions.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                    </select>
                </div>
                <div className="flex overflow-x-auto gap-4 p-2 bg-gray-900/50 rounded-lg horizontal-scroll-container">
                    {participants.filter(r => matchesStatusFilter(r, statusFilter)).map(record => (
                        <CekingCard key={record.id} record={record} onCardClick={handleCardClick} />
                    ))}
                </div>
                 {expandedDetail && participants.some(p => p.id === expandedDetail.id) && (
                    <div className="w-full">
                        <ParticipantDetailView
                            participant={expandedDetail} allRecords={allRecords}
                            onClose={() => handleCardClick(expandedDetail)} 
                            onEdit={onEdit}
                            onDelete={onDelete} 
                            onUpdateLatest={onUpdateLatest}
                        />
                    </div>
                )}
            </div>
        </AnimateOnScroll>
    );
};

const PesertaScreen = ({ records, allRecords, onEdit, onDelete, onUpdateLatest }) => {
    const [expandedDetail, setExpandedDetail] = useState(null);

    const recordsForPesertaView = useMemo(() => {
        return records.filter(record => 
            !record.status.startsWith('Evaluasi') && record.status !== 'Lulus'
        );
    }, [records]);

    const participantGroups = useMemo(() => {
        const tcGroups = {};
        const seitaiGroup = [];
        const athleticGroup = [];

        const seitaiParticipantNames = new Set();
        const athleticParticipantNames = new Set();
        allRecords.forEach(record => {
            if (record.status === 'Training Seitai') seitaiParticipantNames.add(record.nama);
            if (record.status === 'Training Athletic Massage') athleticParticipantNames.add(record.nama);
        });

        recordsForPesertaView.forEach(record => {
            const isOnSeitaiPath = seitaiParticipantNames.has(record.nama);
            const isOnAthleticPath = athleticParticipantNames.has(record.nama);

            if (isOnSeitaiPath) seitaiGroup.push(record);
            else if (isOnAthleticPath) athleticGroup.push(record);
            else if (record.trainganDari) {
                if (!tcGroups[record.trainganDari]) tcGroups[record.trainganDari] = [];
                tcGroups[record.trainganDari].push(record);
            }
        });

        const sortedTcGroups = Object.entries(tcGroups)
            .sort(([, a], [, b]) => b.length - a.length)
            .map(([name, participants]) => ({ name: `Lokasi ${name}`, participants }));

        if (athleticGroup.length > 0) {
            athleticGroup.sort((a, b) => a.nama.localeCompare(b.nama));
            sortedTcGroups.unshift({ name: 'Trainingan Athletic Massage', participants: athleticGroup });
        }
        if (seitaiGroup.length > 0) {
            seitaiGroup.sort((a, b) => a.nama.localeCompare(b.nama));
            sortedTcGroups.unshift({ name: 'Trainingan Seitai', participants: seitaiGroup });
        }
        return sortedTcGroups;
    }, [recordsForPesertaView, allRecords]);

    const colors = useMemo(() => ['border-indigo-500', 'border-purple-500', 'border-teal-500', 'border-pink-500', 'border-sky-500'], []);
    
    const handleCardClick = (record) => {
        if (expandedDetail && expandedDetail.id === record.id) setExpandedDetail(null);
        else setExpandedDetail(record);
    };

    return (
        <main className="flex-grow overflow-y-auto p-4 md:p-8 pt-4 flex flex-col gap-8">
            {participantGroups.map(({ name, participants }, index) => (
                <ParticipantGroup 
                    key={name}
                    name={name}
                    participants={participants}
                    allRecords={allRecords}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onUpdateLatest={onUpdateLatest}
                    colors={colors}
                    index={index}
                    expandedDetail={expandedDetail}
                    handleCardClick={handleCardClick}
                />
            ))}
        </main>
    );
};

const CabangGroup = ({ cabang, recordsForCabangView, colors, index, onCardClick }) => {
    const [evaluationCategoryFilter, setEvaluationCategoryFilter] = useState('semua');

    const cabangParticipants = useMemo(() => recordsForCabangView.filter(r => (r.turunKeCabang === cabang || r.cabang === cabang)), [recordsForCabangView, cabang]);

    const evaluationCounts = useMemo(() => {
        const counts = {
            reflexology: cabangParticipants.filter(r => matchesEvaluationCategoryFilter(r, 'Evaluasi Reflexology')).length,
            athletic: cabangParticipants.filter(r => matchesEvaluationCategoryFilter(r, 'Evaluasi Athletic Massage')).length,
            seitai: cabangParticipants.filter(r => matchesEvaluationCategoryFilter(r, 'Evaluasi Seitai')).length,
        };
        counts.semua = counts.reflexology + counts.athletic + counts.seitai;
        return counts;
    }, [cabangParticipants]);

    const evaluationFilterOptions = useMemo(() => {
        const options = [
            { value: 'semua', label: `Tampilkan Semua (${evaluationCounts.semua})` },
            { value: 'Evaluasi Reflexology', label: `Reflexology (${evaluationCounts.reflexology})`, count: evaluationCounts.reflexology },
            { value: 'Evaluasi Athletic Massage', label: `Athletic Massage (${evaluationCounts.athletic})`, count: evaluationCounts.athletic },
            { value: 'Evaluasi Seitai', label: `Seitai (${evaluationCounts.seitai})`, count: evaluationCounts.seitai },
        ];
        return options.filter(opt => opt.value === 'semua' || opt.count > 0);
    }, [evaluationCounts]);

    return (
        <AnimateOnScroll>
            <div className={`bg-gray-800 rounded-xl shadow-neumorphic border-2 ${colors[index % colors.length]} p-4 sm:p-6 space-y-4`}>
                <div className="flex flex-col sm:flex-row justify-between items-center gap-4">
                    <h2 className="text-xl sm:text-2xl md:text-3xl font-bold text-white text-center sm:text-left">{`Evaluasi Therapist ${cabang}`}</h2>
                    <select value={evaluationCategoryFilter} onChange={(e) => setEvaluationCategoryFilter(e.target.value)} onClick={(e) => e.stopPropagation()} className="select-rounded-border !py-2 !px-3 !text-sm w-full sm:w-auto">
                        {evaluationFilterOptions.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                    </select>
                </div>
                <div className="flex overflow-x-auto gap-4 p-2 bg-gray-900/50 rounded-lg horizontal-scroll-container">
                   {cabangParticipants.filter(r => matchesEvaluationCategoryFilter(r, evaluationCategoryFilter)).map(record => (
                        <CekingCard key={record.id} record={record} onCardClick={onCardClick} />
                    ))}
                </div>
            </div>
        </AnimateOnScroll>
    );
};

const CabangScreen = ({ records, allRecords, onEdit, onDelete, onUpdateLatest }) => {
    const [expandedDetail, setExpandedDetail] = useState(null);

    const recordsForCabangView = useMemo(() => {
        return records.filter(record => record.status === 'Lulus' || record.status.startsWith('Evaluasi'));
    }, [records]);

    const relevantCabangs = useMemo(() => {
        const counts = recordsForCabangView.reduce((acc, record) => {
            const branch = record.turunKeCabang || record.cabang;
            if (branch) acc[branch] = (acc[branch] || 0) + 1;
            return acc;
        }, {});
        return Object.keys(counts).sort((a, b) => counts[b] - a.length);
    }, [recordsForCabangView]);

    const colors = useMemo(() => ['border-indigo-500', 'border-purple-500', 'border-teal-500', 'border-pink-500', 'border-sky-500'], []);

    const handleCardClick = (record) => {
        if (expandedDetail && expandedDetail.id === record.id) setExpandedDetail(null);
        else setExpandedDetail(record);
    };

    return (
        <main className="flex-grow overflow-y-auto p-4 md:p-8 pt-4 flex flex-col gap-8">
            {relevantCabangs.map((cabang, index) => {
                 const cabangParticipants = recordsForCabangView.filter(r => (r.turunKeCabang === cabang || r.cabang === cabang));
                return (
                    <div key={cabang}>
                        <CabangGroup 
                            cabang={cabang}
                            recordsForCabangView={recordsForCabangView}
                            colors={colors}
                            index={index}
                            onCardClick={handleCardClick}
                        />
                         {expandedDetail && cabangParticipants.some(r => r.id === expandedDetail.id) && (
                            <div className="w-full">
                                <ParticipantDetailView
                                    participant={expandedDetail} allRecords={allRecords}
                                    onClose={() => setExpandedDetail(null)} 
                                    onEdit={onEdit}
                                    onDelete={onDelete} 
                                    onUpdateLatest={onUpdateLatest}
                                />
                            </div>
                        )}
                    </div>
                );
            })}
        </main>
    );
};

// =================================================================================
// KOMPONEN BARU: FITUR KOMPLAINAN
// =================================================================================
const ComplaintFormPopup = ({ onClose, onSave, therapists, branches, initialData }) => {
    const { currentUser } = useContext(AppContext);
    const [isSaving, setIsSaving] = useState(false);
    const [formData, setFormData] = useState({
        therapistName: '', customerName: '', complaintDate: new Date().toISOString().split('T')[0],
        cabang: '', complaintDetails: '', status: 'Baru', resolutionDetails: '',
        reportedBy: currentUser?.nama || ''
    });
    const [therapistSuggestions, setTherapistSuggestions] = useState([]);

    useEffect(() => {
        if (initialData) {
            setFormData({
                therapistName: initialData.therapistName || '',
                customerName: initialData.customerName || '',
                complaintDate: initialData.complaintDate || new Date().toISOString().split('T')[0],
                cabang: initialData.cabang || '',
                complaintDetails: initialData.complaintDetails || '',
                status: initialData.status || 'Baru',
                resolutionDetails: initialData.resolutionDetails || '',
                reportedBy: initialData.reportedBy || currentUser?.nama,
            });
        }
    }, [initialData, currentUser]);
    
    const handleChange = (e) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
    };

    const handleTherapistChange = (e) => {
        const { value } = e.target;
        setFormData(prev => ({...prev, therapistName: value }));
        if (value.trim()) {
            const filtered = therapists.filter(t => t.nama.toLowerCase().includes(value.toLowerCase()));
            setTherapistSuggestions(filtered);
        } else {
            setTherapistSuggestions([]);
        }
    };

    const handleTherapistSuggestionClick = (therapist) => {
        setFormData(prev => ({...prev, therapistName: therapist.nama }));
        setTherapistSuggestions([]);
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setIsSaving(true);
        try {
            await onSave(formData, initialData?.id || null);
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 p-4" onClick={onClose}>
            <form onSubmit={handleSubmit} className="popup-wrapper popup-wrapper-visible bg-gray-800 p-6 rounded-xl shadow-neumorphic w-full max-w-lg border-2 border-red-500 flex flex-col max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
                <h2 className="text-2xl font-bold text-center text-red-300 mb-4 flex-shrink-0">{initialData ? 'Edit Komplain' : 'Tambah Komplain Baru'}</h2>
                <div className="flex-grow overflow-y-auto pr-2 space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="relative">
                            <label className="block mb-2 text-gray-300">Nama Terapis</label>
                            <input type="text" name="therapistName" value={formData.therapistName} onChange={handleTherapistChange} onBlur={() => setTimeout(() => setTherapistSuggestions([]), 150)} className="w-full input-rounded-border" required autoComplete="off" placeholder="Ketik untuk mencari..."/>
                            {therapistSuggestions.length > 0 && (
                                <ul className="absolute z-30 w-full bg-gray-700 border border-gray-600 rounded-md mt-1 max-h-48 overflow-y-auto shadow-lg">
                                    {therapistSuggestions.map(suggestion => (
                                        <li key={suggestion.id} className="px-4 py-2 cursor-pointer hover:bg-gray-600 text-white" onMouseDown={() => handleTherapistSuggestionClick(suggestion)}>
                                            {suggestion.nama}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                        <div><label className="block mb-2 text-gray-300">Cabang</label><select name="cabang" value={formData.cabang} onChange={handleChange} className="w-full select-rounded-border" required><option value="">Pilih Cabang</option>{branches.map(b => <option key={b} value={b}>{b}</option>)}</select></div>
                        <div><label className="block mb-2 text-gray-300">Nama Customer</label><input type="text" name="customerName" value={formData.customerName} onChange={handleChange} className="w-full input-rounded-border" /></div>
                        <div><label className="block mb-2 text-gray-300">Tanggal Komplain</label><input type="date" name="complaintDate" value={formData.complaintDate} onChange={handleChange} className="w-full input-rounded-border" required /></div>
                    </div>
                    <div><label className="block mb-2 text-gray-300">Detail Komplain</label><textarea name="complaintDetails" value={formData.complaintDetails} onChange={handleChange} className="w-full textarea-rounded-border h-28" required></textarea></div>
                    {initialData && (
                        <>
                            <div><label className="block mb-2 text-gray-300">Status Komplain</label><select name="status" value={formData.status} onChange={handleChange} className="w-full select-rounded-border"><option value="Baru">Baru</option><option value="Diproses">Diproses</option><option value="Selesai">Selesai</option></select></div>
                            {formData.status === 'Selesai' && (
                                <div><label className="block mb-2 text-gray-300">Detail Solusi/Penyelesaian</label><textarea name="resolutionDetails" value={formData.resolutionDetails} onChange={handleChange} className="w-full textarea-rounded-border h-28"></textarea></div>
                            )}
                        </>
                    )}
                </div>
                <div className="flex justify-end gap-3 mt-4 pt-4 border-t border-gray-700 flex-shrink-0">
                    <button type="button" onClick={onClose} className="px-4 py-2 bg-gray-600 text-white font-semibold rounded-lg hover:bg-gray-700">Batal</button>
                    <button type="submit" disabled={isSaving} className="px-4 py-2 bg-red-600 text-white font-semibold rounded-lg hover:bg-red-700 disabled:bg-red-800 disabled:cursor-not-allowed flex items-center justify-center w-40">
                       {isSaving ? <SpinnerIcon /> : (initialData ? 'Simpan Perubahan' : 'Simpan Komplain')}
                    </button>
                </div>
            </form>
        </div>
    );
};

const ComplaintCard = ({ complaint, onEdit, onDelete, onShowDetail, photo }) => {
    const { openModal, closeModal } = useContext(AppContext);
    const [isExpanded, setIsExpanded] = useState(false);

    const getStatusStyle = (status) => {
        switch (status) {
            case 'Baru': return 'bg-red-500 text-white';
            case 'Diproses': return 'bg-yellow-500 text-black';
            case 'Selesai': return 'bg-green-500 text-white';
            default: return 'bg-gray-500 text-white';
        }
    };

    const handleDeleteClick = (e) => {
        e.stopPropagation();
        openModal('confirmation', {
            title: "Hapus Komplain?",
            message: `Anda yakin ingin menghapus komplain untuk ${complaint.therapistName} secara permanen?`,
            confirmText: "Ya, Hapus",
            onConfirm: async () => {
                await onDelete(complaint.id);
                closeModal();
            }
        });
    };
    
    const handleFollowUpClick = (e) => {
        e.stopPropagation();
        onEdit(complaint);
    };

    return (
        <div 
            className="bg-gray-800 rounded-lg shadow-neumorphic border-l-4 border-red-500 flex flex-col transition-all duration-300 cursor-pointer"
            onClick={() => setIsExpanded(!isExpanded)}
        >
            <div className="p-3 flex-grow">
                <div className="flex justify-between items-start mb-2">
                    <div className="flex items-center gap-3">
                        <div className="w-12 h-12 rounded-full bg-gray-700 flex-shrink-0 overflow-hidden">
                           {photo ? <img src={photo} alt={complaint.therapistName} className="w-full h-full object-cover"/> : <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-gray-500 m-auto" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clipRule="evenodd" /></svg>}
                        </div>
                        <div>
                             <h3 className="text-base font-bold text-white hover:text-blue-300" onClick={(e) => { e.stopPropagation(); onShowDetail(); }}>{complaint.therapistName}</h3>
                             <p className="text-xs text-gray-400">{complaint.cabang}</p>
                        </div>
                    </div>
                     <span className={`text-xs font-bold px-2 py-1 rounded-full ${getStatusStyle(complaint.status)}`}>{complaint.status}</span>
                </div>
                 <p className="text-xs text-gray-500 my-1">{formatDateString(complaint.complaintDate)}</p>
                <p className={`text-sm text-gray-300 bg-gray-900/50 p-2 rounded-md transition-all duration-300 ${isExpanded ? 'h-auto' : 'h-12 overflow-hidden text-ellipsis'}`}>
                    {complaint.complaintDetails}
                </p>
                 {isExpanded && (
                    <div className="mt-3 pt-3 border-t border-gray-700 space-y-2 text-sm">
                        <div>
                            <strong className="text-gray-400">Nama Customer:</strong>
                            <p className="text-white">{complaint.customerName || '-'}</p>
                        </div>
                        {complaint.status === 'Selesai' && complaint.resolutionDetails && (
                            <div>
                                <strong className="text-gray-400">Detail Solusi:</strong>
                                <p className="text-white bg-green-900/20 p-2 rounded-md">{complaint.resolutionDetails}</p>
                            </div>
                        )}
                         <div>
                            <strong className="text-gray-400">Dilaporkan Oleh:</strong>
                            <p className="text-white">{complaint.reportedBy || '-'}</p>
                        </div>
                    </div>
                )}
            </div>
            <div className="bg-gray-900/50 p-2 flex justify-end gap-2 rounded-b-lg">
                <button onClick={handleDeleteClick} title="Hapus" className="p-1.5 bg-gray-700 text-red-400 rounded-md hover:bg-red-900/50"><svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 012 0v6a1 1 0 11-2 0V8z" clipRule="evenodd" /></svg></button>
                <button onClick={handleFollowUpClick} className="text-xs px-3 py-1 bg-blue-600 rounded-md font-semibold">Tindak Lanjut</button>
            </div>
        </div>
    );
};

const ComplaintScreen = () => {
    const { complaints, openModal, allRecords, showToast } = useContext(AppContext);
    const { uniqueLatestRecords } = useRecords('', 'semua', '');
    const firestore = useFirestore();

    const [filterStatus, setFilterStatus] = useState('Semua');
    const [searchTerm, setSearchTerm] = useState('');

    const activeTherapists = useMemo(() => {
        return uniqueLatestRecords.filter(p => !['Resign', 'Ganti Peserta'].includes(p.status));
    }, [uniqueLatestRecords]);
    
    const allBranches = useMemo(() => {
        const branches = new Set(complaints.map(c => c.cabang).filter(Boolean));
        activeTherapists.forEach(t => {
            if (t.turunKeCabang) branches.add(t.turunKeCabang);
            if (t.cabang) branches.add(t.cabang);
        });
        return Array.from(branches).sort();
    }, [complaints, activeTherapists]);

    const filteredComplaints = useMemo(() => {
        return complaints.filter(c => {
            const statusMatch = filterStatus === 'Semua' || c.status === filterStatus;
            const searchMatch = !searchTerm || c.therapistName.toLowerCase().includes(searchTerm.toLowerCase());
            return statusMatch && searchMatch;
        });
    }, [complaints, filterStatus, searchTerm]);

    const handleSaveComplaint = async (formData, complaintId) => {
        const success = await firestore.addOrUpdateComplaint(complaintId, formData);
        if (success) {
            openModal(null); // Close the form modal
        }
    };
    
    const openComplaintForm = (complaintToEdit = null) => {
        openModal('complaintForm', {
            onSave: handleSaveComplaint,
            therapists: activeTherapists,
            branches: allBranches,
            initialData: complaintToEdit,
        });
    };
    
    const handleShowDetail = (therapistName) => {
        const therapistRecord = uniqueLatestRecords.find(r => r.nama === therapistName);
        if (therapistRecord) {
            openModal('participantDetail', {
                participant: therapistRecord, 
                allRecords,
                onEdit: (rec) => showToast("Fungsi edit dari halaman ini belum diaktifkan."),
                onDelete: firestore.softDeleteRecord,
                onUpdateLatest: (rec) => showToast("Fungsi update dari halaman ini belum diaktifkan."),
            });
        } else {
            showToast(`Data detail untuk ${therapistName} tidak ditemukan.`);
        }
    };

    const statusCounts = useMemo(() => {
        return complaints.reduce((acc, c) => {
            acc[c.status] = (acc[c.status] || 0) + 1;
            return acc;
        }, { Baru: 0, Diproses: 0, Selesai: 0 });
    }, [complaints]);

    return (
        <div className="p-4 md:p-8 space-y-6">
            <div className="flex flex-col sm:flex-row justify-between items-center gap-4">
                <h2 className="text-2xl md:text-3xl font-bold text-red-300">Manajemen Komplain</h2>
                <button onClick={() => openComplaintForm(null)} className="px-4 py-2 bg-red-600 text-white font-semibold rounded-lg hover:bg-red-700 shadow-neumorphic w-full sm:w-auto">
                    + Tambah Komplain
                </button>
            </div>
            <div className="bg-gray-800 p-4 rounded-xl shadow-neumorphic space-y-4">
                <div className="flex flex-col sm:flex-row gap-4">
                    <input type="text" placeholder="Cari nama terapis..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="input-rounded-border flex-grow"/>
                    <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="select-rounded-border">
                        <option value="Semua">Semua Status ({complaints.length})</option>
                        <option value="Baru">Baru ({statusCounts.Baru})</option>
                        <option value="Diproses">Diproses ({statusCounts.Diproses})</option>
                        <option value="Selesai">Selesai ({statusCounts.Selesai})</option>
                    </select>
                </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {filteredComplaints.length > 0 ? (
                    filteredComplaints.map(c => {
                        const therapist = activeTherapists.find(t => t.nama === c.therapistName);
                        return <ComplaintCard 
                                    key={c.id} 
                                    complaint={c} 
                                    onEdit={openComplaintForm} 
                                    onDelete={firestore.deleteComplaint}
                                    onShowDetail={() => handleShowDetail(c.therapistName)}
                                    photo={therapist?.photo || null}
                               />;
                    })
                ) : (
                    <p className="col-span-full text-center text-gray-400 py-10">Tidak ada data komplain yang cocok.</p>
                )}
            </div>
        </div>
    );
};


// =================================================================================
// KOMPONEN NAVIGASI & FITUR PERBAIKAN DATA
// =================================================================================
const MergeDataPopup = ({ onClose, onConfirm, field, incorrectValue, correctValue, count }) => (
    <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-[80] p-4" onClick={onClose}>
        <div className="popup-wrapper popup-wrapper-visible bg-gray-800 p-8 rounded-xl shadow-neumorphic w-full max-w-lg border-2 border-green-500" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-2xl font-bold text-center text-green-300 mb-4">Konfirmasi Penggabungan Data</h2>
            <p className="text-center text-gray-300 mb-2">Anda akan menggabungkan <span className="font-bold text-white">{count}</span> data.</p>
            <div className="text-center bg-gray-900/50 p-4 rounded-lg">
                <p className="text-gray-400">Pada kolom <span className="font-semibold text-white">{field}</span>:</p>
                <p className="text-red-400">{incorrectValue}</p>
                <p className="text-gray-400">akan diubah menjadi</p>
                <p className="text-green-400">{correctValue}</p>
            </div>
            <p className="text-center text-xs text-gray-500 mt-4">Tindakan ini tidak dapat diurungkan. Pastikan pilihan Anda sudah benar.</p>
            <div className="flex justify-center gap-4 pt-6">
                <button onClick={onClose} className="px-6 py-2 bg-gray-600 text-white font-bold rounded-lg hover:bg-gray-700">Batal</button>
                <button onClick={onConfirm} className="px-6 py-2 bg-green-600 text-white font-bold rounded-lg hover:bg-green-700">Ya, Gabungkan</button>
            </div>
        </div>
    </div>
);

const MasterDataManagementPopup = ({ onClose, records }) => {
    const firestore = useFirestore();
    const { openModal, closeModal, showToast, dropdownOptions } = useContext(AppContext);
    const [mode, setMode] = useState('merge');
    const [isSaving, setIsSaving] = useState(false);
    
    const [selectedMergeField, setSelectedMergeField] = useState('trainer');
    const [incorrectValue, setIncorrectValue] = useState('');
    const [correctValue, setCorrectValue] = useState('');

    const [selectedManageField, setSelectedManageField] = useState('cabangList');
    const [newOption, setNewOption] = useState('');

    const fieldsToMerge = [ { key: 'trainer', label: 'Trainer' }, { key: 'trainganDari', label: 'Training Dari' }, { key: 'turunKeCabang', label: 'Turun Ke Cabang' }, { key: 'cabang', label: 'Cabang Evaluasi' }, { key: 'refrensi', label: 'Refrensi' }, ];
    const fieldsToManage = [ { key: 'cabangList', label: 'Daftar Cabang' }, { key: 'trainingDariList', label: 'Daftar Training Dari' } ];
    
    const uniqueValuesForMerge = useMemo(() => {
        if (!selectedMergeField || !records) return [];
        const values = new Set(records.map(r => r[selectedMergeField]).filter(Boolean));
        return Array.from(values).sort();
    }, [selectedMergeField, records]);

    const handleMerge = async () => {
        if (!selectedMergeField || !incorrectValue || !correctValue || incorrectValue === correctValue) {
            showToast("Harap pilih nilai yang valid dan berbeda.");
            return;
        }
        
        const recordsToChange = records.filter(r => r[selectedMergeField] === incorrectValue);
        
        openModal('mergeData', {
            field: fieldsToMerge.find(f => f.key === selectedMergeField)?.label,
            incorrectValue, correctValue, count: recordsToChange.length,
            onConfirm: async () => {
                setIsSaving(true);
                try {
                    const success = await firestore.mergeMasterData(selectedMergeField, incorrectValue, correctValue);
                    if (success) { closeModal(); closeModal(); }
                } finally {
                    setIsSaving(false);
                }
            }
        });
    };

    const handleAddOption = async () => {
        if (!newOption.trim()) {
            showToast("Nama opsi tidak boleh kosong.");
            return;
        }
        setIsSaving(true);
        try {
            await firestore.updateDropdownOptions(selectedManageField, newOption.trim(), 'add');
            setNewOption('');
        } finally {
            setIsSaving(false);
        }
    };
    
    const handleDeleteOption = async (option) => {
        await firestore.updateDropdownOptions(selectedManageField, option, 'remove');
    };

    return (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-[70] p-4" onClick={onClose}>
            <div className="popup-wrapper popup-wrapper-visible bg-gray-800 p-6 rounded-xl shadow-neumorphic w-full max-w-2xl border-2 border-green-500 flex flex-col max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
                <h2 className="text-2xl font-bold text-center text-green-300 mb-4">Manajemen Data Induk</h2>
                
                <div className="flex border-b border-gray-600 mb-4">
                    <button onClick={() => setMode('merge')} className={`flex-1 py-2 text-center font-semibold ${mode === 'merge' ? 'text-blue-400 border-b-2 border-blue-400' : 'text-gray-400'}`}>Gabungkan Data</button>
                    <button onClick={() => setMode('manage')} className={`flex-1 py-2 text-center font-semibold ${mode === 'manage' ? 'text-blue-400 border-b-2 border-blue-400' : 'text-gray-400'}`}>Kelola Daftar Opsi</button>
                </div>

                <div className="flex-grow overflow-auto pr-2">
                    {mode === 'merge' && (
                        <div className="space-y-4">
                            <div><label className="block mb-2 text-gray-300">Pilih Kolom Data</label><select value={selectedMergeField} onChange={e => { setSelectedMergeField(e.target.value); setIncorrectValue(''); setCorrectValue(''); }} className="w-full select-rounded-border">{fieldsToMerge.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}</select></div>
                            <div><label className="block mb-2 text-gray-300">Nilai yang Salah (Akan Diubah)</label><select value={incorrectValue} onChange={e => setIncorrectValue(e.target.value)} className="w-full select-rounded-border bg-red-900/20 border-red-500"><option value="">Pilih nilai...</option>{uniqueValuesForMerge.map(val => <option key={val} value={val}>{val}</option>)}</select></div>
                            <div><label className="block mb-2 text-gray-300">Nilai yang Benar (Menjadi Tujuan)</label><select value={correctValue} onChange={e => setCorrectValue(e.target.value)} className="w-full select-rounded-border bg-green-900/20 border-green-500"><option value="">Pilih nilai...</option>{uniqueValuesForMerge.filter(v => v !== incorrectValue).map(val => <option key={val} value={val}>{val}</option>)}</select></div>
                             <div className="flex justify-end gap-3 pt-4">
                                <button onClick={onClose} className="px-6 py-2 bg-gray-600 text-white font-bold rounded-lg hover:bg-gray-700">Tutup</button>
                                <button onClick={handleMerge} disabled={isSaving} className="px-6 py-2 bg-green-600 text-white font-bold rounded-lg hover:bg-green-700 disabled:bg-green-800 flex items-center justify-center w-40">
                                    {isSaving ? <SpinnerIcon /> : 'Gabungkan Data'}
                                </button>
                            </div>
                        </div>
                    )}
                    {mode === 'manage' && (
                        <div className="space-y-4">
                            <div><label className="block mb-2 text-gray-300">Pilih Daftar Opsi</label><select value={selectedManageField} onChange={e => setSelectedManageField(e.target.value)} className="w-full select-rounded-border">{fieldsToManage.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}</select></div>
                            <div className="flex gap-2">
                                <input type="text" value={newOption} onChange={e => setNewOption(e.target.value)} placeholder="Ketik nama opsi baru..." className="w-full input-rounded-border" />
                                <button onClick={handleAddOption} disabled={isSaving} className="px-4 py-2 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 flex-shrink-0 disabled:bg-blue-800 flex items-center justify-center w-24">
                                    {isSaving ? <SpinnerIcon /> : 'Tambah'}
                                </button>
                            </div>
                            <div className="max-h-60 overflow-y-auto space-y-2 bg-gray-900/50 p-3 rounded-lg">
                                {dropdownOptions[selectedManageField].map(option => (
                                    <div key={option} className="flex justify-between items-center bg-gray-800 p-2 rounded-md">
                                        <span className="text-white">{option}</span>
                                        <button onClick={() => handleDeleteOption(option)} className="p-1 text-red-400 hover:text-red-200"><svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 012 0v6a1 1 0 11-2 0V8z" clipRule="evenodd" /></svg></button>
                                    </div>
                                ))}
                            </div>
                            <div className="flex justify-end pt-4"><button onClick={onClose} className="px-6 py-2 bg-gray-600 text-white font-bold rounded-lg hover:bg-gray-700">Tutup</button></div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

const NavMenu = ({ setActiveView, onEditParticipant, activeRecords, uniqueLatestRecords, allRecords, activeStaffForSummary }) => {
    const { currentUser, showToast, setCurrentUser, setUserRole, setLoginStep, openModal } = useContext(AppContext);
    const { attendanceParticipants, allFilterOptions } = useRecords('', 'semua');
    const reports = useReports(onEditParticipant, activeRecords);
    const [isNavMenuOpen, setIsNavMenuOpen] = useState(false);
    const navMenuRef = useRef(null);

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (navMenuRef.current && !navMenuRef.current.contains(event.target)) {
                setIsNavMenuOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const handleMenuClick = (action) => {
        action();
        setIsNavMenuOpen(false);
    };

    const handleLogout = () => {
        setCurrentUser(null);
        setUserRole(null);
        setLoginStep('login');
        showToast("Anda telah berhasil logout.");
    };

    const handleOpenAttendance = () => {
        const seitaiParticipantNames = new Set();
        const athleticParticipantNames = new Set();
        allRecords.forEach(record => {
            if (record.status === 'Training Seitai') {
                seitaiParticipantNames.add(record.nama);
            }
            if (record.status === 'Training Athletic Massage') {
                athleticParticipantNames.add(record.nama);
            }
        });

        const athletic = attendanceParticipants.filter(p => athleticParticipantNames.has(p.nama));
        const seitai = attendanceParticipants.filter(p => seitaiParticipantNames.has(p.nama));
        const tc = attendanceParticipants.filter(p => !athleticParticipantNames.has(p.nama) && !seitaiParticipantNames.has(p.nama));
        
        openModal('attendance', { 
            tcParticipants: tc,
            athleticParticipants: athletic,
            seitaiParticipants: seitai,
            locations: allFilterOptions.tc 
        });
    };

    return (
        <div ref={navMenuRef} className="relative">
            <button onClick={() => setIsNavMenuOpen(p => !p)} className="p-3 bg-gray-700 rounded-lg shadow-neumorphic">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16m-7 6h7" /></svg>
            </button>
            {isNavMenuOpen && (
                <div className="absolute top-full right-0 mt-2 w-64 bg-gray-700 rounded-lg shadow-lg z-20 border border-gray-600 p-2 space-y-1">
                   <div className="px-4 py-2"><p className="text-sm text-gray-400">Pengguna:</p><p className="font-bold text-white truncate">{currentUser?.nama}</p></div>
                   <div className="border-t border-gray-600 my-1"></div>
                   {currentUser?.permissions?.daftarHadir && <button onClick={() => handleMenuClick(handleOpenAttendance)} className="w-full text-left px-4 py-2 rounded-md font-semibold text-white bg-emerald-500 hover:bg-emerald-600">Daftar Hadir</button>}
                   {currentUser?.permissions?.tindakLanjut && <button onClick={() => handleMenuClick(() => openModal('followUpDateRange', { onFetch: reports.handleFetchFollowUp }))} className="w-full text-left px-4 py-2 rounded-md font-semibold text-white bg-indigo-500 hover:bg-indigo-600">Tindak Lanjut</button>}
                   {currentUser?.permissions?.hasilKerja && <button onClick={() => handleMenuClick(() => openModal('trainerPerformanceDateRange', { onFetch: reports.handleFetchTrainerPerformanceByDate }))} className="w-full text-left px-4 py-2 rounded-md font-semibold text-white bg-indigo-500 hover:bg-indigo-600">Hasil Kerja</button>}
                   {currentUser?.permissions?.rangkumanKeahlian && <button onClick={() => handleMenuClick(() => openModal('skillsSummary', { allRecords, activeParticipants: uniqueLatestRecords }))} className="w-full text-left px-4 py-2 rounded-md font-semibold text-white bg-sky-500 hover:bg-sky-600">Rangkuman Keahlian</button>}
                   {currentUser?.permissions?.perbaikanData && <button onClick={() => handleMenuClick(() => openModal('masterData', { records: activeRecords }))} className="w-full text-left px-4 py-2 rounded-md font-semibold text-white bg-amber-500 hover:bg-amber-600">Perbaikan Data</button>}
                   {currentUser?.permissions?.izinAkses && <button onClick={() => handleMenuClick(() => setActiveView('izinAkses'))} className="w-full text-left px-4 py-2 rounded-md font-semibold text-white bg-violet-500 hover:bg-violet-600">Izin Akses</button>}
                   {currentUser?.permissions?.trash && <button onClick={() => handleMenuClick(() => setActiveView('trash'))} className="w-full text-left px-4 py-2 rounded-md font-semibold text-white bg-rose-500 hover:bg-rose-600">Tong Sampah</button>}
                   {currentUser?.permissions?.hapusBeberapa && <button onClick={() => handleMenuClick(() => openModal('bulkDeleteDateRange', { onFetch: reports.handleFetchForBulkDelete }))} className="w-full text-left px-4 py-2 rounded-md font-semibold text-white bg-red-600 hover:bg-red-700">Hapus Beberapa Data</button>}
                   <div className="border-t border-gray-600 my-1"></div>
                   <button onClick={() => handleMenuClick(handleLogout)} className="w-full text-left px-4 py-2 rounded-md font-semibold text-white bg-slate-500 hover:bg-slate-600">Logout</button>
                </div>
            )}
        </div>
    );
};


// =================================================================================
// KOMPONEN UTAMA APLIKASI (Main App Component)
// =================================================================================
function AppContent() {
  const { isRecordsLoading, currentUser, showToast, activityNotifications, setLastSaveTimestamp, postSaveAction, setPostSaveAction, openModal, closeModal, dropdownOptions } = useContext(AppContext);
  const firestore = useFirestore();
  const [isSaving, setIsSaving] = useState(false);
  
  const [isFormExpanded, setIsFormExpanded] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeView, setActiveView] = useState('peserta');
  const [selectedBranchFilter, setSelectedBranchFilter] = useState('semua');
  const [evaluationNotifications, setEvaluationNotifications] = useState([]);
  const [showNotificationPopup, setShowNotificationPopup] = useState(false);
  const notificationBellRef = useRef(null);
  const addFormRef = useRef(null);
  const fileInputRef = useRef(null);

  const { allRecords, activeRecords, deletedRecords, uniqueLatestRecords, filteredRecords, allFilterOptions, attendanceParticipants } = useRecords(searchTerm, selectedBranchFilter, activeView);

  const initialFormState = useMemo(() => ({
      nama: '', tgl: '', trainer: currentUser?.nama || '', status: 'Training Reflexology', tahapCeking: '',
      photo: null, kotaAsal: '', tanggalMasuk: '', refrensi: '', turunKeCabang: '', 
      accYangMeluluskan: '', trainganDari: '', tanggalLulus: '', tanggalResign: '', 
      cabang: '', evaluationResult: '', cekingResult:'', isDeleted: false,
      penilaian: null,
      cekingType: 'Reflexology',
  }), [currentUser]);

  const { formValues, setFormValues, recordToEdit, setRecordToEdit, nameSuggestions, setNameSuggestions, handleFormInputChange, handleSuggestionClick, resetForm } = useForm(initialFormState, uniqueLatestRecords, allRecords, currentUser);
  
    const isSpecialTrainingPath = useMemo(() => {
        const specialStatuses = ['Training Seitai', 'Training Athletic Massage'];
        if (specialStatuses.includes(formValues.status)) {
            return true;
        }
        const nameToCheck = recordToEdit?.nama || formValues.nama;
        if (nameToCheck) {
            return allRecords.some(r => r.nama === nameToCheck && specialStatuses.includes(r.status));
        }
        return false;
    }, [formValues.status, formValues.nama, recordToEdit, allRecords]);

  const handleEditClick = useCallback((record) => {
    let newFormValues = { ...initialFormState, ...record };
    if (record.status.startsWith('Ceking tahap')) {
        newFormValues.tahapCeking = record.status; newFormValues.status = 'Tahap Ceking'; newFormValues.cekingResult = 'Masih Tahap Ceking';
    } else if (record.status === 'Lulus') {
        newFormValues.status = 'Tahap Ceking'; newFormValues.cekingResult = 'Lulus';
    }
    setRecordToEdit(record); 
    setFormValues(newFormValues); 
    setIsFormExpanded(true);
    if (addFormRef.current) addFormRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveView('peserta');
  }, [initialFormState, setFormValues, setRecordToEdit]);

  const handleUpdateLatestClick = useCallback((record) => {
    const firstRecordWithPhoto = allRecords
        .filter(r => r.nama === record.nama && r.photo)
        .sort((a, b) => (a.createdAt?.toDate() || 0) - (b.createdAt?.toDate() || 0))[0];

    setFormValues({
        ...initialFormState,
        nama: record.nama,
        photo: firstRecordWithPhoto ? firstRecordWithPhoto.photo : (record.photo || null),
        status: 'Tahap Ceking',
        trainer: currentUser?.nama || '',
    });
    setRecordToEdit(null);
    setIsFormExpanded(true);
    if (addFormRef.current) addFormRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [allRecords, initialFormState, setFormValues, setRecordToEdit, currentUser]);

  useEffect(() => {
    const handleClickOutside = (event) => {
        if (notificationBellRef.current && !notificationBellRef.current.contains(event.target)) {
            setShowNotificationPopup(false);
        }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => { setSelectedBranchFilter('semua'); }, [activeView]);
  
  useEffect(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const evaluationCandidates = uniqueLatestRecords.filter(record => record.status === 'Lulus' || record.status.startsWith('Evaluasi'));
    const notifications = evaluationCandidates.map(record => {
        const lastDateStr = record.tanggalLulus || record.tgl;
        if (!lastDateStr) return null;
        const lastDate = new Date(`${lastDateStr}T00:00:00Z`);
        if (isNaN(lastDate.getTime())) return null;
        const dueDate = new Date(lastDate);
        dueDate.setMonth(dueDate.getMonth() + 3);
        if (dueDate <= today) {
            let nextEval = 'Evaluasi Lanjutan';
            if (record.status === 'Lulus') nextEval = 'Evaluasi Reflexology';
            else if (record.status.startsWith('Evaluasi ')) nextEval = record.status;
            return { ...record, dueDate: dueDate, nextEvaluation: nextEval };
        }
        return null;
    }).filter(Boolean);
    setEvaluationNotifications(notifications);
  }, [uniqueLatestRecords]);


  const handleFileSelect = useCallback(async (e) => {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = async (event) => { 
            try {
                showToast("Mengompres gambar...");
                const compressed = await compressImage(event.target.result);
                setFormValues(prev => ({...prev, photo: compressed}));
                showToast("Gambar berhasil dikompres!");
            } catch (error) { showToast("Gagal mengompres gambar."); setFormValues(prev => ({...prev, photo: event.target.result}));}
        };
        reader.readAsDataURL(file);
    }
  }, [showToast, setFormValues]);

  const handleAddOrUpdateRecord = async (e) => {
    e.preventDefault();
    setIsSaving(true);
    
    try {
        const { status, kotaAsal, trainganDari, cabang, cekingResult, turunKeCabang } = formValues;
        const errors = [];
        
        if (status.startsWith('Training') && status !== 'Training Seitai') {
            if (!kotaAsal) errors.push('Kota Asal');
            if (!trainganDari) errors.push('Training Dari');
        } else if (status === 'Training Seitai') {
            if (!cabang) errors.push('Cabang');
        } else if (status === 'Tahap Ceking') {
            if (cekingResult === 'Lulus' && !turunKeCabang) errors.push('Cabang (Turun Ke Cabang)');
        } else if (status.startsWith('Evaluasi')) {
            if (!cabang) errors.push('Cabang');
        }
        
        if (errors.length > 0) {
            openModal('formValidationWarning', { title: 'Formulir Tidak Lengkap', errors });
            return;
        }

        let dataToSave = { ...formValues };

        if (formValues.status === 'Tahap Ceking') {
          dataToSave.status = formValues.cekingResult === 'Lulus' ? 'Lulus' : (formValues.tahapCeking || getNextCekingStage(formValues.nama, activeRecords));
        }
        const success = await firestore.addOrUpdateRecord(recordToEdit ? recordToEdit.id : null, dataToSave);
        if (success) {
            resetForm();
            setLastSaveTimestamp(Date.now());
            if (postSaveAction === 'reopenAttendance') {
                openModal('attendance', { participants: attendanceParticipants, locations: allFilterOptions.tc });
                setPostSaveAction(null);
            }
        }
    } finally {
        setIsSaving(false);
    }
  };

  const handleSaveAssessment = (assessmentData) => {
    setFormValues(prev => ({ ...prev, penilaian: assessmentData }));
    showToast("Data penilaian telah disimpan sementara. Klik 'Simpan' untuk finalisasi.");
  };
  
    const handleNotificationClick = (recordId) => {
        if (!recordId) return;
        const record = allRecords.find(r => r.id === recordId);
        if (record) {
            setShowNotificationPopup(false);
            openModal('participantDetail', { 
                participant: record, 
                allRecords, 
                onEdit: handleEditClick, 
                onDelete: firestore.softDeleteRecord,
                onUpdateLatest: handleUpdateLatestClick,
            });
        } else {
            showToast("Data peserta tidak ditemukan.");
        }
    };

  const mainFilterOptions = useMemo(() => {
    if (activeView === 'peserta') return { label: "Lokasi TC", options: allFilterOptions.tc };
    if (activeView === 'cabang' || activeView === 'jadwal') return { label: "Cabang", options: allFilterOptions.cabang };
    return { label: "Filter", options: [] };
  }, [activeView, allFilterOptions]);

  const combinedBranchList = useMemo(() => {
    const combined = new Set([...dropdownOptions.cabangList, ...allFilterOptions.cabang]);
    return Array.from(combined).sort();
  }, [dropdownOptions.cabangList, allFilterOptions.cabang]);

  const combinedTrainingDariList = useMemo(() => {
      const combined = new Set([...dropdownOptions.trainingDariList, ...allFilterOptions.tc]);
      return Array.from(combined).sort();
  }, [dropdownOptions.trainingDariList, allFilterOptions.tc]);

    const activeStaffForSummary = useMemo(() => {
        return uniqueLatestRecords.filter(p => {
            const isTraining = p.status.startsWith('Training');
            const isCeking = p.status.startsWith('Ceking tahap') || p.status === 'Tahap Ceking';
            const isResign = p.status === 'Resign' || p.status === 'Ganti Peserta';
            return !isTraining && !isCeking && !isResign;
        });
    }, [uniqueLatestRecords]);

  const renderContent = () => {
    const screenProps = { 
        records: filteredRecords, 
        allRecords: allRecords, 
        onEdit: handleEditClick, 
        onDelete: firestore.softDeleteRecord,
        onUpdateLatest: handleUpdateLatestClick,
    };
    
    if (isRecordsLoading) {
        return <LoadingSpinner fullScreen={false} />;
    }

    switch(activeView) {
        case 'peserta': return <PesertaScreen {...screenProps} />;
        case 'cabang': return <CabangScreen {...screenProps} />;
        case 'izinAkses': return <AccessManagementScreen />;
        case 'jadwal': return <EvaluationScheduleScreen latestRecords={filteredRecords} allRecords={allRecords} onEdit={handleEditClick} onDelete={firestore.softDeleteRecord} onUpdateLatest={handleUpdateLatestClick} />;
        case 'komplainan': return <ComplaintScreen />;
        case 'trash': return <TrashScreen deletedRecords={deletedRecords} onRestore={firestore.restoreRecord} onDeletePermanent={firestore.deleteRecordPermanent} />;
        default: return null;
    }
  };
  
  return (
    <div className="h-screen flex flex-col bg-gray-900 text-white overflow-hidden">
      <div className="flex-shrink-0">
          <div ref={addFormRef} className="p-4 pt-6 md:px-8">
              <div className="bg-gray-800 rounded-xl shadow-neumorphic border-2 border-purple-500 overflow-hidden">
                  <div onClick={() => setIsFormExpanded(p => !p)} className="p-4 flex flex-col sm:flex-row justify-between items-center gap-4 bg-gray-700/50 cursor-pointer">
                      <div className="flex items-center gap-3 self-start">
                          <h2 className="text-xl font-bold text-blue-300">Pendaftaran Peserta</h2>
                          <svg className={`w-6 h-6 text-blue-300 transition-transform duration-300 ${!isFormExpanded ? '-rotate-180' : ''}`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" /></svg>
                      </div>
                      <input type="text" placeholder="Cari Nama..." onClick={(e) => e.stopPropagation()} className="w-full sm:max-w-xs input-rounded-border" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
                  </div>
                  <DynamicForm
                      isFormExpanded={isFormExpanded} formValues={formValues} setFormValues={setFormValues} handleFormInputChange={handleFormInputChange}
                      handleAddOrUpdateRecord={handleAddOrUpdateRecord} resetForm={resetForm} fileInputRef={fileInputRef}
                      handleFileSelect={handleFileSelect} activeRecords={activeRecords}
                      handleSuggestionClick={handleSuggestionClick} nameSuggestions={nameSuggestions} setNameSuggestions={setNameSuggestions}
                      isSpecialTrainingPath={isSpecialTrainingPath}
                      branchList={combinedBranchList}
                      trainingDariList={combinedTrainingDariList}
                      isSaving={isSaving}
                      onOpenAssessment={() => openModal('assessment', { 
                          onSave: handleSaveAssessment, 
                          initialData: formValues.penilaian, 
                          evaluationStatus: formValues.status === 'Tahap Ceking' ? `Ceking ${formValues.cekingType}` : formValues.status 
                      })}
                  />
              </div>
          </div>

          <div className="p-4 md:px-8">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <button onClick={() => setActiveView('peserta')} className={`py-3 rounded-lg text-lg font-bold transition-colors ${activeView === 'peserta' ? 'bg-purple-600 text-white' : 'bg-gray-700 text-gray-300'}`}>Daftar Peserta</button>
                <button onClick={() => setActiveView('cabang')} className={`py-3 rounded-lg text-lg font-bold transition-colors ${activeView === 'cabang' ? 'bg-purple-600 text-white' : 'bg-gray-700 text-gray-300'}`}>Cabang</button>
                <button onClick={() => setActiveView('jadwal')} className={`py-3 rounded-lg text-lg font-bold transition-colors ${activeView === 'jadwal' ? 'bg-purple-600 text-white' : 'bg-gray-700 text-gray-300'}`}>Jadwal Evaluasi</button>
                <button onClick={() => setActiveView('komplainan')} className={`py-3 rounded-lg text-lg font-bold transition-colors ${activeView === 'komplainan' ? 'bg-purple-600 text-white' : 'bg-gray-700 text-gray-300'}`}>Komplainan</button>
              </div>
          </div>
          
          {(activeView === 'peserta' || activeView === 'cabang' || activeView === 'jadwal') && (
            <div className="px-4 md:px-8 pb-4 flex flex-wrap items-center gap-4">
                <select value={selectedBranchFilter} onChange={(e) => setSelectedBranchFilter(e.target.value)} className="select-rounded-border flex-grow">
                    <option value="semua">Tampilkan Semua {mainFilterOptions.label}</option>
                    <optgroup label={mainFilterOptions.label}>
                        {mainFilterOptions.options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                    </optgroup>
                </select>
                
                <div ref={notificationBellRef} className="relative">
                    <button onClick={() => setShowNotificationPopup(p => !p)} className="p-3 bg-gray-700 rounded-lg shadow-neumorphic">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>
                        {(evaluationNotifications.length + activityNotifications.length) > 0 && (
                            <span className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs font-bold text-white">
                                {evaluationNotifications.length + activityNotifications.length}
                            </span>
                        )}
                    </button>
                     {showNotificationPopup && (
                        <NotificationBellPopup 
                            evaluationNotifications={evaluationNotifications} 
                            activityNotifications={activityNotifications}
                            onClose={() => setShowNotificationPopup(false)} 
                            onNotificationClick={handleNotificationClick}
                        />
                    )}
                </div>
                
                <NavMenu 
                    setActiveView={setActiveView} 
                    onEditParticipant={handleEditClick} 
                    activeRecords={activeRecords}
                    uniqueLatestRecords={uniqueLatestRecords}
                    allRecords={allRecords}
                    activeStaffForSummary={activeStaffForSummary}
                />

            </div>
          )}
      </div>
      
      <div className="flex-grow overflow-y-auto">
        {renderContent()}
      </div>
    </div>
  );
}

const ModalManager = () => {
    const { modal, closeModal } = useContext(AppContext);
    if (!modal.type) return null;

    switch (modal.type) {
        case 'assessment': return <AssessmentPopup onClose={closeModal} {...modal.props} />;
        case 'attendance': return <AttendancePopup onClose={closeModal} {...modal.props} />;
        case 'formValidationWarning': return <FormValidationWarningPopup onClose={closeModal} {...modal.props} />;
        case 'followUpDateRange': return <FollowUpDateRangePopup onClose={closeModal} {...modal.props} />;
        case 'followUpDetails': return <FollowUpDetailsPopup onClose={closeModal} {...modal.props} />;
        case 'trainerPerformanceDateRange': return <FollowUpDateRangePopup onClose={closeModal} {...modal.props} />;
        case 'trainerPerformanceList': return <TrainerPerformanceListPopup onClose={closeModal} {...modal.props} />;
        case 'trainerWorkDetail': return <TrainerWorkDetailPopup onClose={closeModal} {...modal.props} />;
        case 'bulkDeleteDateRange': return <BulkDeleteDateRangePopup onClose={closeModal} {...modal.props} />;
        case 'bulkDeleteData': return <BulkDeleteDataPopup onClose={closeModal} {...modal.props} />;
        case 'masterData': return <MasterDataManagementPopup onClose={closeModal} {...modal.props} />;
        case 'mergeData': return <MergeDataPopup onClose={closeModal} {...modal.props} />;
        case 'superAdminLogin': return <SuperAdminPopup onClose={closeModal} {...modal.props} />;
        case 'skillsSummary': return <SkillsSummaryPopup onClose={closeModal} {...modal.props} />;
        case 'complaintForm': return <ComplaintFormPopup onClose={closeModal} {...modal.props} />;
        case 'confirmation': return <ConfirmationDialog show={true} onClose={closeModal} {...modal.props} />;
        case 'participantAttendanceReportDateRange': return <ParticipantAttendanceReportDateRangePopup onClose={closeModal} {...modal.props} />;
        case 'realtimeParticipantAttendanceReport': return <ReportDisplayPopup onClose={closeModal} {...modal.props} />;
        case 'participantDetail':
            return (
                <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-[90] p-4" onClick={closeModal}>
                    <div className="popup-wrapper popup-wrapper-visible w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
                        <ParticipantDetailView {...modal.props} onClose={closeModal} />
                    </div>
                </div>
            );
        default: return null;
    }
};

function MainApp() {
    const { loginStep, isAuthReady, isLoginDataReady } = useContext(AppContext);

    if (!isAuthReady || !isLoginDataReady) {
        return <LoadingSpinner />;
    }
    
    return (
        <>
            {loginStep === 'login' ? <LoginScreen /> : <AppContent />}
            <ModalManager />
        </>
    );
}

function App() {
    useEffect(() => {
        let viewportMeta = document.querySelector('meta[name="viewport"]');
        if (!viewportMeta) {
            viewportMeta = document.createElement('meta');
            viewportMeta.name = 'viewport';
            viewportMeta.content = 'width=device-width, initial-scale=1.0';
            document.head.appendChild(viewportMeta);
        }

        if (!document.getElementById('app-manifest-link')) {
            const manifestContent = {
              "name": "Manajemen Peserta Kokuo",
              "short_name": "Peserta Kokuo",
              "description": "Aplikasi untuk manajemen dan pelaporan data peserta Kokuo.",
              "start_url": ".",
              "display": "standalone",
              "background_color": "#111827",
              "theme_color": "#111827",
              "icons": [
                { "src": "https://i.ibb.co/jvSJGBC/kokuo-logo-512.jpg", "sizes": "72x72", "type": "image/jpeg" },
                { "src": "https://i.ibb.co/jvSJGBC/kokuo-logo-512.jpg", "sizes": "96x96", "type": "image/jpeg" },
                { "src": "https://i.ibb.co/jvSJGBC/kokuo-logo-512.jpg", "sizes": "128x128", "type": "image/jpeg" },
                { "src": "https://i.ibb.co/jvSJGBC/kokuo-logo-512.jpg", "sizes": "144x144", "type": "image/jpeg" },
                { "src": "https://i.ibb.co/jvSJGBC/kokuo-logo-512.jpg", "sizes": "152x152", "type": "image/jpeg" },
                { "src": "https://i.ibb.co/604jKG3/kokuo-logo-192.jpg", "sizes": "192x192", "type": "image/jpeg", "purpose": "any maskable" },
                { "src": "https://i.ibb.co/jvSJGBC/kokuo-logo-512.jpg", "sizes": "384x384", "type": "image/jpeg" },
                { "src": "https://i.ibb.co/jvSJGBC/kokuo-logo-512.jpg", "sizes": "512x512", "type": "image/jpeg" }
              ]
            };

            const manifestBlob = new Blob([JSON.stringify(manifestContent)], { type: 'application/json' });
            const manifestUrl = URL.createObjectURL(manifestBlob);
            const manifestLink = document.createElement('link');
            manifestLink.id = 'app-manifest-link';
            manifestLink.rel = 'manifest';
            manifestLink.href = manifestUrl;
            document.head.appendChild(manifestLink);

            let themeColor = document.querySelector('meta[name="theme-color"]');
            if (!themeColor) {
                themeColor = document.createElement('meta');
                themeColor.name = 'theme-color';
                themeColor.content = '#111827';
                document.head.appendChild(themeColor);
            }

            let appleIcon = document.querySelector('link[rel="apple-touch-icon"]');
            if (!appleIcon) {
                appleIcon = document.createElement('link');
                appleIcon.rel = 'apple-touch-icon';
                appleIcon.href = 'https://i.ibb.co/604jKG3/kokuo-logo-192.jpg';
                document.head.appendChild(appleIcon);
            }

            let favicon = document.querySelector('link[rel="icon"]');
            if (favicon) {
                favicon.href = 'https://i.ibb.co/604jKG3/kokuo-logo-192.jpg';
            } else {
                favicon = document.createElement('link');
                favicon.rel = 'icon';
                favicon.href = 'https://i.ibb.co/604jKG3/kokuo-logo-192.jpg';
                favicon.type = 'image/jpeg';
                document.head.appendChild(favicon);
            }
        }
    }, []);

    const customStyles = `
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
      html, body, #root { min-height: 100vh; min-height: -webkit-fill-available; scroll-behavior: smooth; }
      body { font-family: 'Inter', sans-serif; background-color: #111827; color: #ffffff; max-width: 100%; overflow-x: hidden; }
      .shadow-neumorphic { box-shadow: 4px 4px 6px rgba(0, 0, 0, 0.6), -4px -4px 6px rgba(255, 255, 255, 0.05); }
      .shadow-inner-custom { box-shadow: inset 2px 2px 4px rgba(0, 0, 0, 0.7), inset -2px -2px 4px rgba(255, 255, 255, 0.1); }
      @keyframes fade-in-up { from { opacity: 0; transform: translateY(20px) translateX(-50%); } to { opacity: 1; transform: translateY(0) translateX(-50%); } }
      .animate-fade-in-up { animation: fade-in-up 0.3s ease-out forwards; }
      @keyframes fade-in-up-view { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
      .animate-fade-in-up-view { animation: fade-in-up-view 0.5s ease-out forwards; }
      .input-rounded-border, .select-rounded-border, .textarea-rounded-border { background-color: #1a1a1a; border: 1px solid #4a90e2; border-radius: 8px; padding: 12px; outline: none; color: #ffffff; font-size: 16px; box-shadow: inset 2px 2px 4px rgba(0, 0, 0, 0.7), inset -2px -2px 4px rgba(255, 255, 255, 0.1); }
      .input-rounded-border:focus, .select-rounded-border:focus, .textarea-rounded-border:focus { border-color: #60a5fa; }
      .select-rounded-border { -webkit-appearance: none; -moz-appearance: none; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='white'%3E%3Cpath fill-rule='evenodd' d='M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z' clip-rule='evenodd'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 0.7rem center; background-size: 1.5em; padding-right: 2.5rem; }
      .horizontal-scroll-container::-webkit-scrollbar { height: 8px; }
      .horizontal-scroll-container::-webkit-scrollbar-track { background: #333; border-radius: 10px; }
      .horizontal-scroll-container::-webkit-scrollbar-thumb { background: #555; border-radius: 10px; }
      .details-section { max-height: 1500px; overflow: hidden; transition: max-height 0.5s ease-in-out, opacity 0.5s ease-in-out, padding 0.5s ease-in-out; opacity: 1; }
      .details-section-hidden { max-height: 0; opacity: 0; padding-top: 0 !important; padding-bottom: 0 !important; margin-top: 0 !important; }
      @keyframes slide-in-up-scroll { from { opacity: 0; transform: translateY(40px); } to { opacity: 1; transform: translateY(0); } }
      .animate-on-scroll { animation: slide-in-up-scroll 0.6s ease-out forwards; }
      .popup-wrapper { transition: opacity 300ms ease-out, transform 300ms ease-out; opacity: 0; transform: scale(0.95); }
      .popup-wrapper-visible { opacity: 1; transform: scale(1); }
      .text-gradient {
        background: linear-gradient(45deg, #f87171, #fb923c, #facc15, #4ade80, #38bdf8, #a78bfa);
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
      }
    `;
    return (
        <AppProvider>
            <style>{customStyles}</style>
            <MainApp />
        </AppProvider>
    );
}

export default App;



