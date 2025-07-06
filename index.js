const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');

// --- CẤU HÌNH ---
const app = express();
const PORT = 3001;
// ID của Google Sheet của bạn (lấy từ URL)
const SPREADSHEET_ID = '1TZlC29NcOT9qycyfZXOshuR-3EvgI4cPXPKr7msFTzE'; // <<<< THAY ID CỦA BẠN VÀO ĐÂY

app.use(cors());
app.use(express.json());

// --- CÁC HÀM TIỆN ÍCH ---

// Hàm xác thực và lấy đối tượng Google Sheets
async function getSheetsService() {
    const auth = new google.auth.GoogleAuth({
        keyFile: 'credentials.json',
        scopes: 'https://www.googleapis.com/auth/spreadsheets',
    });
    const client = await auth.getClient();
    return google.sheets({ version: 'v4', auth: client });
}

// Hàm đọc dữ liệu từ một trang tính và chuyển thành JSON
async function readSheet(sheets, range) {
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range,
    });
    const rows = response.data.values;
    if (!rows || rows.length < 2) return []; // Cần ít nhất 1 hàng header và 1 hàng dữ liệu
    const headers = rows[0];
    return rows.slice(1).map(row => {
        const obj = {};
        headers.forEach((header, index) => {
            obj[header] = row[index] || '';
        });
        return obj;
    });
}

// Hàm ghi một hàng mới vào trang tính
async function appendRow(sheets, range, data) {
    const headersResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${range}!1:1`,
    });
    const headers = headersResponse.data.values[0];
    const newRow = headers.map(header => data[header] || '');

    await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: range,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
            values: [newRow],
        },
    });
    return data;
}

// Hàm cập nhật một hàng (dựa vào ID)
async function updateRow(sheets, range, id, data) {
    const allData = await readSheet(sheets, range);
    const rowIndex = allData.findIndex(row => row.id === id);
    if (rowIndex === -1) throw new Error('Row not found');

    const headersResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${range}!1:1`,
    });
    const headers = headersResponse.data.values[0];
    const updatedRow = headers.map(header => data[header] ?? allData[rowIndex][header]);

    await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${range}!A${rowIndex + 2}`, // +2 vì index bắt đầu từ 0 và hàng 1 là header
        valueInputOption: 'USER_ENTERED',
        requestBody: {
            values: [updatedRow],
        },
    });
    return data;
}

// Hàm xoá một hàng (dựa vào ID)
async function deleteRow(sheets, range, id) {
    const allData = await readSheet(sheets, range);
    const rowIndex = allData.findIndex(row => row.id === id);
    if (rowIndex === -1) throw new Error('Row not found');

    // Để xoá hàng, chúng ta cần một request phức tạp hơn
    await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
            requests: [{
                deleteDimension: {
                    range: {
                        sheetId: await getSheetIdByName(sheets, range), // Cần lấy sheetId
                        dimension: 'ROWS',
                        startIndex: rowIndex + 1, // +1 vì index hàng của API bắt đầu từ 0 và header ở hàng 0
                        endIndex: rowIndex + 2,
                    },
                },
            }, ],
        },
    });
}

// Hàm tiện ích để lấy sheetId từ tên trang tính
async function getSheetIdByName(sheets, sheetName) {
    const metaData = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const sheet = metaData.data.sheets.find(s => s.properties.title === sheetName);
    if (!sheet) throw new Error(`Sheet with name ${sheetName} not found`);
    return sheet.properties.sheetId;
}


// --- API ENDPOINTS ---

// Generic CRUD endpoints factory
function createCrudEndpoints(resource, sheetName) {
    const router = express.Router();

    router.get('/', async (req, res) => {
        try {
            const sheets = await getSheetsService();
            let data = await readSheet(sheets, sheetName);
            // Handle filtering if query params exist (e.g., /users?role=Bác sĩ)
            if (Object.keys(req.query).length > 0) {
              data = data.filter(item => {
                return Object.entries(req.query).every(([key, value]) => item[key] == value);
              });
            }
            res.json(data);
        } catch (e) { res.status(500).json({ message: e.message }); }
    });

    router.post('/', async (req, res) => {
        try {
            const sheets = await getSheetsService();
            const newItem = { ...req.body, id: `${resource}-${Date.now()}` };
            await appendRow(sheets, sheetName, newItem);
            res.status(201).json(newItem);
        } catch (e) { res.status(500).json({ message: e.message }); }
    });

    router.put('/:id', async (req, res) => {
        try {
            const sheets = await getSheetsService();
            const updatedItem = await updateRow(sheets, sheetName, req.params.id, req.body);
            res.json(updatedItem);
        } catch (e) { res.status(500).json({ message: e.message }); }
    });

    router.delete('/:id', async (req, res) => {
        try {
            const sheets = await getSheetsService();
            await deleteRow(sheets, sheetName, req.params.id);
            res.status(204).send();
        } catch (e) { res.status(500).json({ message: e.message }); }
    });
    
    return router;
}


// Sử dụng factory để tạo các routes
app.use('/api/users', createCrudEndpoints('user', 'Users'));
app.use('/api/operating-rooms', createCrudEndpoints('or', 'OperatingRooms'));
app.use('/api/surgery-types', createCrudEndpoints('st', 'SurgeryTypes'));
// Patients có thể là một phần của Surgeries hoặc một sheet riêng
app.use('/api/patients', createCrudEndpoints('patient', 'Patients')); 


// Endpoints đặc thù cho Surgeries
const surgeriesRouter = express.Router();
surgeriesRouter.get('/', async (req, res) => {
    const { date } = req.query;
    try {
        const sheets = await getSheetsService();
        let allSurgeries = await readSheet(sheets, 'Surgeries');
        
        if (date) {
            allSurgeries = allSurgeries.filter(s => {
                const surgeryDate = new Date(s.scheduledDateTime).toISOString().split('T')[0];
                return surgeryDate === date;
            });
        }
        
        // Populate surgeon details
        const users = await readSheet(sheets, 'Users');
        const populatedSurgeries = allSurgeries.map(s => {
            const surgeonDetails = users.find(u => u.id === s.surgeonId);
            return { ...s, surgeon: surgeonDetails || { name: 'Không rõ' } };
        });

        res.json(populatedSurgeries);
    } catch (e) { res.status(500).json({ message: e.message }); }
});

surgeriesRouter.post('/', async (req, res) => {
    try {
        const sheets = await getSheetsService();
        // Backend sẽ gán ID và status
        const newSurgeryData = { 
            ...req.body, 
            id: `surg-${Date.now()}`,
            status: 'Đã lên lịch',
            surgeonId: req.body.surgeon.id // Chỉ lưu ID của bác sĩ
        };
        delete newSurgeryData.surgeon; // Xóa object surgeon thừa
        
        await appendRow(sheets, 'Surgeries', newSurgeryData);
        res.status(201).json({ ...req.body, ...newSurgeryData });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

surgeriesRouter.put('/:id', async (req, res) => {
    try {
        const sheets = await getSheetsService();
        const updateData = {
            ...req.body,
            surgeonId: req.body.surgeon.id,
        };
        delete updateData.surgeon;
        await updateRow(sheets, 'Surgeries', req.params.id, updateData);
        res.json(req.body);
    } catch (e) { res.status(500).json({ message: e.message }); }
});

surgeriesRouter.patch('/:id/status', async (req, res) => {
    try {
        const { status, time } = req.body;
        const sheets = await getSheetsService();
        const allSurgeries = await readSheet(sheets, 'Surgeries');
        const surgeryToUpdate = allSurgeries.find(s => s.id === req.params.id);
        if (!surgeryToUpdate) return res.status(404).json({message: 'Surgery not found'});

        const updateData = { ...surgeryToUpdate, status };
        if (status === 'Đang mổ') {
            updateData.startTime = time || new Date().toISOString();
        }
        if (status === 'Hoàn thành') {
            updateData.endTime = time || new Date().toISOString();
        }

        await updateRow(sheets, 'Surgeries', req.params.id, updateData);
        res.json(updateData);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});
app.use('/api/surgeries', surgeriesRouter);


// Endpoint đăng nhập giả lập
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const sheets = await getSheetsService();
        const users = await readSheet(sheets, 'Users');
        const user = users.find(u => u.email === email);
        if (user && password === 'password') { // Giả lập check password
            res.json(user);
        } else {
            res.status(401).json({ message: 'Email hoặc mật khẩu không đúng.' });
        }
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`Backend server is running on port ${PORT}`);
    console.log(`Make sure your Google Sheet ID is set to: ${SPREADSHEET_ID}`);
});