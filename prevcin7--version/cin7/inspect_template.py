import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
import openpyxl

path = r'c:\Users\Harshili Patni\OneDrive - VNC Global Business Edge Pvt Ltd\Desktop\cin7\Controller_Reporting_Model_v5_Cin7_Actuals.xlsx'
wb = openpyxl.load_workbook(path, read_only=True, data_only=False)

print('ALL SHEETS:')
for i, name in enumerate(wb.sheetnames):
    safe = name.encode('ascii', 'replace').decode()
    print(f'  {i+1}. {safe}')

wb.close()
