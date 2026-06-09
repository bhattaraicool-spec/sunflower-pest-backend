DROP YOUR IMAGE FILES HERE
==========================

Place these three files directly in this folder (public/images/):

1. logo.png
   → App logo image
   → Used in: header (both pages), Home page hero, Contact page
   → The app will show a gold placeholder box if this file is missing

2. Shrestha_Govinda_2025_WEB.avif
   → Professor Dr. Govinda Shrestha's photo
   → Used in: Contact page
   → The app will show a 👤 placeholder if this file is missing

3. Picture1.png
   → Sunflower growth stages reference image
   → Used in: Home page
   → The app will show a dashed placeholder box if this file is missing

After dropping the files here, they are immediately served at:
  /images/logo.png
  /images/Shrestha_Govinda_2025_WEB.avif
  /images/Picture1.png

No server restart needed — files are served statically.


GOOGLE SHEETS — Avg_Pest_Per_Week_Per_Trap Formula
===================================================
After adding the new column header "Avg_Pest_Per_Week_Per_Trap" in column X (row 1),
paste this formula into cell X2 and drag it down for all data rows:

=IFERROR(
  SUMPRODUCT(
    ((B$2:B$10000=B2)
     *(D$2:D$10000>=D2-6)
     *(D$2:D$10000<=D2))
    *(G$2:G$10000+H$2:H$10000+I$2:I$10000
      +Q$2:Q$10000+R$2:R$10000+S$2:S$10000
      +T$2:T$10000+U$2:U$10000+V$2:V$10000+W$2:W$10000)
  )/7,
0)

Column mapping (for reference):
  A=ID, B=Trap_ID, C=County, D=Visit_Date, E=Latitude, F=Longitude
  G=BSMoth_Count, H=Carthuri_Count, I=SunfMoth_Count
  J=Pest_Zone, K=Observer_Name, L=Trap_Type, M=Crop_Type
  N=Crop_Stage, O=Lure_Changed, P=Comments
  Q=RedSFWeevil_Count, R=GraySFWeevil_Count, S=DectesSB_Count
  T=SoybeanAphid_Count, U=ECornBorer_Count, V=CornRootworm_Count
  W=AlfWeevil_Count
  X=Avg_Pest_Per_Week_Per_Trap (formula column — server leaves blank)
