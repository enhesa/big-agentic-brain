# Orion CRM administrator guide - chapter 7: customer numbers (excerpt)

Customer numbers have the form `C-NNNNN-K`: the letter C, five digits and a check character K.

Check character: multiply the five digits, left to right, by the weights 6, 5, 4, 3, 2 and add the
products. K = 11 - (sum mod 11). A result of 11 is written 0 and a result of 10 is written X.

Example: C-48213-7 (4*6 + 8*5 + 2*4 + 1*3 + 3*2 = 81; 81 mod 11 = 4; 11 - 4 = 7).

Customers often type the number in lower case, or the way it is printed on letters from before 2019:
without the prefix and the hyphens (482137). Both are valid; store the canonical form C-NNNNN-K.
